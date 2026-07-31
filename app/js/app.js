(function () {
  const STORAGE_KEY = 'originStories:v1';

  const state = {
    storyType: null,
    answers: {},
    titleTouched: false,
    previewIndex: 0,
  };

  // Tracks the most recent upload started per photo field id, so that if a
  // parent picks one photo, then quickly picks a different one before the
  // first has finished being read/cropped (both are async), the slower
  // first upload can't win the race and silently overwrite the second,
  // more recent choice once it finally resolves.
  const photoUploadSeq = {};

  // Tracks, per photo field id, whether the last upload attempt for it ended
  // in the "not a usable image" error banner. Purely ephemeral DOM state
  // (errorMsg.hidden) with nothing recording it in state.answers used to mean
  // any unrelated renderFields() rebuild (changing numSiblings/parentsLabel/
  // adoptionPath, or an async photo crop finishing) silently discarded the
  // banner -- the parent lost the only signal their photo never made it in,
  // with the download left unblocked (photo is optional) since nothing else
  // shows a broken state. Found by a fresh-eyes review 2026-07-28.
  const photoUploadErrorShown = {};

  // Tracks, per photo field id, whether the currently-shown error banner has
  // already been announced once (via role="alert") since it was last raised.
  // buildPhotoUpload() recreates the whole widget from scratch on every
  // renderFields() rebuild -- including ones triggered by a totally unrelated
  // field change (numSiblings/parentsLabel/adoptionPath/...) -- so without
  // this, a screen reader re-announces the error every single time, since
  // each rebuild inserts a brand-new role="alert" node already populated with
  // the visible error text. Found by a fresh-eyes review 2026-07-29.
  const photoUploadErrorAnnounced = {};

  // True from the moment Download disables its button until buildAndSaveDoc()
  // finishes (two requestAnimationFrame callbacks later — see downloadBook()).
  // A blocking confirm()/alert() dialog pauses queued rAF callbacks along with
  // the rest of the event loop, so a parent who clicks Download, then Start
  // a new story (which opens a confirm()) before those two frames have
  // painted, can clear state.answers/state.storyType out from under the
  // still-pending PDF build — it would resume once the dialog closes and
  // silently save a bogus, empty-state PDF. Guarding startOver()/
  // selectStoryType() on this flag closes that window (and the equivalent,
  // dialog-free race against a fast story-type-card click).
  let isGeneratingPdf = false;

  // Counts photo uploads currently being read/cropped (both async) across all
  // photo fields. cropPhotoToSquare() can take a real stretch on a large photo
  // (measured ~280ms for a 6000x4000 JPEG) — clicking Download inside that
  // window used to silently build the book from whatever was in
  // state.answers.childPhoto BEFORE the upload finished (nothing, on a first
  // upload), producing a keepsake with the generic avatar instead of the
  // photo the parent had just picked, with no error or indication anything
  // was skipped. Gating the Download button (and the click handler itself,
  // in case Enter/a fast click lands before the button re-disables) on this
  // count closes that window.
  let pendingPhotoUploads = 0;

  const els = {};


  function init() {
    els.storyTypes = document.getElementById('story-types');
    els.formSection = document.getElementById('form-section');
    els.fields = document.getElementById('fields');
    els.preview = document.getElementById('book-preview');
    els.pageLabel = document.getElementById('page-label');
    els.pageAnnouncer = document.getElementById('page-announcer');
    els.prevBtn = document.getElementById('prev-page');
    els.nextBtn = document.getElementById('next-page');
    els.downloadBtn = document.getElementById('download-btn');
    els.downloadHint = document.getElementById('download-hint');
    els.charsetWarning = document.getElementById('charset-warning');
    els.downloadError = document.getElementById('download-error');
    els.startOverBtn = document.getElementById('start-over-btn');
    els.savedNote = document.getElementById('saved-note');
    els.saveError = document.getElementById('save-error');
    els.tabConflictWarning = document.getElementById('tab-conflict-warning');

    renderStoryTypeCards();
    els.prevBtn.addEventListener('click', () => movePreview(-1));
    els.nextBtn.addEventListener('click', () => movePreview(1));
    els.downloadBtn.addEventListener('click', downloadBook);
    if (els.startOverBtn) els.startOverBtn.addEventListener('click', startOver);
    // Fires only in OTHER same-origin tabs when they write to localStorage —
    // without this, editing here after another tab changed the same saved
    // story silently overwrites that tab's progress on this tab's next save,
    // with no warning to either tab.
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) checkForStorageConflict(e.oldValue, e.newValue);
      // localStorage.clear() (as opposed to another tab's Start Over, which
      // calls removeItem(STORAGE_KEY)) fires a storage event with
      // key/oldValue/newValue ALL null per spec — a real, if less common,
      // trigger (a "Clear site data" action, a privacy extension, DevTools)
      // that the e.key === STORAGE_KEY filter above silently ignores
      // entirely, the opposite of intent since a full clear is a MORE
      // severe loss than the single-key removeItem case already handled.
      // e.oldValue can't be reused here (also null, not this tab's own
      // last-known content) — reuse the same "compare against what this tab
      // itself would have saved" technique the bfcache/pageshow handler
      // below already uses for the identical class of gap. Found by a
      // fresh-eyes review 2026-07-25.
      else if (e.key === null && state.storyType) {
        checkForStorageConflict(ownLastSavedSnapshot(), null);
      }
    });
    // Pages restored from the back-forward cache (bfcache) — e.g. clicking
    // the header logo to index.html, then hitting Back, a completely
    // ordinary flow — never receive DOM events, including 'storage', that
    // fired while frozen, and browsers do not replay them on restore. A
    // restored tab could therefore miss another tab's edit or "Start a new
    // story" entirely, with its own next keystroke then silently
    // overwriting that other tab's save with no warning at all — the exact
    // data-loss scenario the storage listener above exists to prevent, just
    // via a path it can't see. Reuse the same conflict check, comparing
    // this tab's own last-known-saved state (what saveProgress() would
    // persist right now) against whatever is actually in localStorage after
    // the restore. Found by a fresh-eyes review 2026-07-24.
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted || !state.storyType) return;
      checkForStorageConflict(ownLastSavedSnapshot(), localStorage.getItem(STORAGE_KEY));
    });
    // Without this, a photo dropped anywhere on the page except squarely on
    // the small file-upload button falls through to the browser's own
    // default drop handling — which navigates the whole tab away to display
    // the raw dropped file, silently destroying every answer typed so far.
    // <input type="file"> has its own native (and wanted) drop-to-select
    // behavior, so it's excluded from the guard. Scoped to actual file drops
    // (dataTransfer.types includes "Files") — an earlier version of this
    // guard blocked ALL drops unconditionally, which also silently broke the
    // browser's native "drop selected text into a text field" behavior on
    // every field in the form.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      const isFileDrop = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
      if (isFileDrop && (!(e.target instanceof HTMLInputElement) || e.target.type !== 'file')) {
        e.preventDefault();
      }
    });
    // #save-error already tells a parent in words to finish in one sitting or
    // download before closing the tab (v1.14.1) — but nothing stopped the tab
    // from actually closing. Add the browser's own native "leave site?"
    // prompt as a last line of defense for exactly the moment that banner is
    // already warning about (autosave failing, e.g. private browsing or a
    // full quota), instead of relying solely on a banner a parent might not
    // notice before closing the tab.
    window.addEventListener('beforeunload', (e) => {
      if (els.saveError && !els.saveError.hidden) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    restoreSavedProgress();
    renderPreview();
  }

  function restoreSavedProgress() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      saved = null;
    }
    if (!saved || !saved.storyType) return;

    state.storyType = saved.storyType;
    // Guard against corrupted/hand-edited localStorage the same way the
    // previewIndex/numSiblings/select-field guards below already do: a
    // non-object `answers` (e.g. a string or number, which `|| {}` alone
    // would NOT catch since those can be truthy) would otherwise become
    // state.answers itself — every later `state.answers[f.id] = value`
    // write then silently no-ops (property assignment on a primitive is a
    // no-op in non-strict mode), so the whole form would render as if every
    // field were blank with no visible error at all.
    state.answers =
      saved.answers && typeof saved.answers === 'object' && !Array.isArray(saved.answers) ? saved.answers : {};
    // onFieldChange() only sanitizes control characters/decomposed accents
    // when a field is actively typed into — a value that reached
    // localStorage some other way (a session saved by an older build before
    // this sanitizer existed, or hand-edited/corrupted storage, both a
    // threat model this function already defends against elsewhere) would
    // otherwise reload unsanitized and carry the same "looks fine on screen,
    // wrong in the PDF" bug straight through to a download without the
    // parent ever having typed anything unusual this session.
    // A non-string answer value (corrupted/hand-edited storage — e.g. a
    // number where text was expected) isn't just "unsanitized," it's a
    // landmine: every downstream consumer (buildPages/getParentsList/
    // getSiblingNames/etc.) calls .trim()/.replace() on answer values
    // unconditionally and would throw the first time it touched this key,
    // silently killing the entire preview/download pipeline with no error
    // shown to the parent. Delete it instead so each field's own existing
    // fallback (e.g. childName's `|| 'your child'`) applies, the same as if
    // the key had never been set.
    Object.keys(state.answers).forEach((k) => {
      const v = state.answers[k];
      if (typeof v === 'string') state.answers[k] = sanitizeFieldValue(k, v);
      else if (typeof v !== 'object' || v === null || Array.isArray(v)) delete state.answers[k];
    });
    state.titleTouched = !!saved.titleTouched;
    // Guard against corrupted/hand-edited localStorage: a non-numeric value
    // (e.g. 'x') coerces to NaN, and NaN fails every numeric comparison in
    // renderPreview()'s own clamp (`>= pages.length` / `< 0`), so it would
    // otherwise sail through as an invalid array index and crash on `.kind`.
    const restoredIndex = parseInt(saved.previewIndex, 10);
    state.previewIndex = Number.isFinite(restoredIndex) && restoredIndex >= 0 ? restoredIndex : 0;
    // bookTitle has no `default` in prompts.js (only a placeholder) — normal
    // use always has it populated by selectStoryType()'s own defaulting logic
    // (never reached on a restore), so a saved answers object missing just
    // this one key (hand-edited/corrupted storage, same threat model as the
    // guards above) would otherwise render the title box as blank/unset
    // instead of showing the real, editable default title text. Found by a
    // fresh-eyes review 2026-07-24.
    const restoredStoryType = STORY_TYPES.find((s) => s.id === state.storyType) || STORY_TYPES[0];
    // Normalize state.storyType itself too, not just the local fallback used
    // for bookTitle above — every other consumer (buildPages/getFieldsFor/
    // themeFor/buildOriginSentence) already tolerates an unrecognized id by
    // falling back to adoption, but the card-highlighting loop and the
    // data-theme attribute below both do an exact match against the raw
    // value, so a corrupted/hand-edited storyType left no card selected
    // (and the theme attribute set to a value no CSS selector matches, only
    // coincidentally landing on the right colors via :root's own defaults)
    // even though the form was otherwise fully usable under the same
    // fallback. Found by a fresh-eyes review 2026-07-24.
    state.storyType = restoredStoryType.id;
    if (!state.titleTouched || state.answers.bookTitle === undefined) {
      state.answers.bookTitle = restoredStoryType.defaultTitle;
    }

    [...els.storyTypes.children].forEach((card) => {
      const isSelected = card.dataset.id === state.storyType;
      card.classList.toggle('selected', isSelected);
      card.setAttribute('aria-pressed', String(isSelected));
    });
    els.formSection.hidden = false;
    renderFields();
    if (els.savedNote) els.savedNote.hidden = false;
    document.body.dataset.theme = state.storyType;
    // renderFields() above (via getVisibleFields()/ensureAvatarDefaults())
    // can silently correct corrupted/stale values in state.answers (an
    // out-of-range numSiblings, an invalid select option, a bad avatar
    // sub-field) without ever calling saveProgress() itself — so a restore
    // from corrupted storage leaves the in-memory state corrected but
    // localStorage still holding the original, uncorrected JSON. That
    // divergence is invisible in a single normal session, but a later
    // bfcache restore (see the 'pageshow' listener above) compares this
    // tab's own current state against localStorage and reads the mismatch
    // as another tab having made changes — a false "changed in another
    // open tab" warning with no other tab involved at all. Persisting the
    // corrected state right away keeps the two in sync. Harmless when
    // nothing was corrected: identical JSON doesn't fire a 'storage' event
    // in other tabs. Found by a fresh-eyes review 2026-07-24.
    saveProgress();
  }

  // What saveProgress() would persist right now, as the same JSON string
  // shape a real StorageEvent's oldValue/newValue carry. Used by two
  // listeners that have no live event value to compare against: the
  // pageshow/bfcache-restore handler (frozen tabs receive no events at all
  // while frozen) and the storage listener's localStorage.clear() branch
  // (a clear() event's own oldValue is null too, not this tab's content).
  function ownLastSavedSnapshot() {
    return JSON.stringify({
      storyType: state.storyType,
      answers: state.answers,
      titleTouched: state.titleTouched,
      previewIndex: state.previewIndex,
    });
  }

  // Shared by the 'storage' listener (fires in other tabs on every write, or
  // on a same-origin localStorage.clear()) and the 'pageshow'/bfcache-restore
  // listener — both pass ownLastSavedSnapshot() when there's no live event
  // value to read oldValue from. oldValue/newValue are both raw JSON strings
  // (or null), matching what a real StorageEvent provides.
  function checkForStorageConflict(oldValue, newValue) {
    // Only warn if THIS tab actually has a story of its own that could be
    // lost — a fresh tab that never picked a story has nothing to
    // overwrite, so warning it about another tab's changes is a false
    // alarm that could confuse a parent who just opened the page.
    if (!els.tabConflictWarning || !state.storyType) return;
    // saveProgress() persists previewIndex alongside answers on every save,
    // and movePreview() calls saveProgress() on every Prev/Next click — so
    // simply browsing pages in the other tab (nothing actually edited)
    // still fires this check. Ignore a change that's previewIndex-only;
    // it's not an actual conflict and warning about it is a false alarm,
    // the same "don't warn when there's nothing at stake" reasoning already
    // applied above for a fresh tab. Found by a fresh-eyes review 2026-07-23.
    // titleTouched is the same shape of false alarm: it's internal
    // bookkeeping (only affects whether a FUTURE story-type switch
    // auto-fills the title box), not visible book content — typing a
    // character into the title field and then deleting it back to the
    // original text is an ordinary interaction that flips titleTouched
    // false->true with bookTitle byte-identical before and after. Found by
    // a fresh-eyes review 2026-07-24.
    let onlyIgnorableFieldsChanged = false;
    try {
      // JSON.stringify is sensitive to object KEY INSERTION ORDER, not just
      // deep value equality — and selectStoryType()'s field-clearing
      // (delete state.answers[id], then renderFields() re-creates the key
      // later on a switch back) reorders state.answers's keys without
      // changing any actual value. Two tabs with byte-identical story
      // content but different edit histories then compared as "different"
      // here, firing a false "changed in another tab" warning on an
      // ordinary "clicked through story types, came back" interaction —
      // surviving all 8+ prior fixes to this function, since those all
      // targeted spurious FIELD changes, not spurious key ORDERING on an
      // otherwise-identical object. Sort keys recursively before comparing
      // so ordering can't affect the result. Found by a fresh-eyes review
      // 2026-07-27.
      const stableStringify = (value) => {
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        if (value && typeof value === 'object') {
          return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
        }
        return JSON.stringify(value);
      };
      const normalizeForConflictCheck = (raw) => {
        if (!raw) return raw;
        const parsed = JSON.parse(raw);
        delete parsed.previewIndex;
        delete parsed.titleTouched;
        // selectStoryType()'s field-clearing (see its own comment) only
        // clears a story-type-exclusive field if the value is still exactly
        // the auto-populated default — a touched-then-abandoned field (e.g.
        // peeking IVF, typing into helperDetail, then switching back to
        // Adoption) deliberately survives as an inert dead key in `answers`,
        // since every real CONSUMER of these fields already gates on
        // storyType/adoptionPath. But comparing raw `answers` objects here
        // treated that inert leak as a genuine difference, firing a false
        // "changed in another open tab" warning for an edit that produces a
        // byte-identical rendered book. Strip any answer id that isn't
        // valid for the payload's OWN storyType before comparing — dynamic
        // sibling-name fields aren't part of getFieldsFor()'s static list
        // (see its own comment) so they're allowed through explicitly.
        // Found by a fresh-eyes review 2026-07-28.
        if (parsed.answers && typeof parsed.answers === 'object') {
          const validIds = new Set(getFieldsFor(parsed.storyType).map((f) => f.id));
          for (let i = 1; i <= maxSiblingCount(); i++) validIds.add('siblingName' + i);
          Object.keys(parsed.answers).forEach((k) => {
            if (!validIds.has(k)) delete parsed.answers[k];
          });
        }
        return stableStringify(parsed);
      };
      onlyIgnorableFieldsChanged = normalizeForConflictCheck(oldValue) === normalizeForConflictCheck(newValue);
    } catch (err) {
      // Malformed JSON on either side — fall through and warn, same as the
      // pre-existing behavior.
    }
    if (onlyIgnorableFieldsChanged) return;
    // newValue is null when the other tab removed the key (Start Over), not
    // edited it — "reload to see the changes" would be misleading there,
    // since reloading actually shows an empty story, not new content.
    els.tabConflictWarning.textContent = newValue === null
      ? 'This story was cleared in another open tab (Start a new story). If you keep editing here, your changes will still be overwritten by that — reload this tab to start fresh instead.'
      : 'This story was just changed in another open tab. If you keep editing here, those changes will be overwritten — reload this tab to see them instead.';
    els.tabConflictWarning.hidden = false;
  }

  function saveProgress() {
    if (!state.storyType) return;
    let didSave = true;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        storyType: state.storyType,
        answers: state.answers,
        titleTouched: state.titleTouched,
        previewIndex: state.previewIndex,
      }));
    } catch (e) {
      // localStorage unavailable (private browsing, quota, etc). Surface this —
      // silently swallowing it while still saying "Saved" would falsely tell a
      // parent their work is safe when it isn't.
      didSave = false;
    }
    if (els.savedNote) els.savedNote.hidden = !didSave;
    if (els.saveError) els.saveError.hidden = didSave;
    // A successful save here just overwrote whatever another tab wrote —
    // the warning's "your changes will be overwritten" framing is now
    // backwards (this tab's own changes are what's saved), and since
    // saveProgress() runs on every keystroke with no debounce, leaving it up
    // would make it permanently stuck and increasingly wrong the moment a
    // parent does the single most likely thing after seeing it: keeps
    // typing. Only clear it on a successful save — if the save itself
    // failed, the other tab's data is untouched and the warning still holds.
    if (didSave && els.tabConflictWarning) els.tabConflictWarning.hidden = true;
  }

  function startOver() {
    if (isGeneratingPdf) return;
    if (!confirm("Clear everything you've entered and start a new story?")) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // ignore
    }
    state.storyType = null;
    state.answers = {};
    state.titleTouched = false;
    state.previewIndex = 0;
    // Invalidate any photo upload still being read/cropped (both async) so
    // it can't resolve after this reset and silently write a photo back
    // into the answers we just cleared — same guard buildPhotoUpload's own
    // "Remove photo" button uses for one field, applied to all of them here.
    Object.keys(photoUploadSeq).forEach((id) => { photoUploadSeq[id] = (photoUploadSeq[id] || 0) + 1; });
    Object.keys(photoUploadErrorShown).forEach((id) => { photoUploadErrorShown[id] = false; });
    Object.keys(photoUploadErrorAnnounced).forEach((id) => { photoUploadErrorAnnounced[id] = false; });
    [...els.storyTypes.children].forEach((card) => {
      card.classList.remove('selected');
      card.setAttribute('aria-pressed', 'false');
    });
    els.formSection.hidden = true;
    // #start-over-btn (which may hold focus right now) lives inside savedNote —
    // hiding it without moving focus first would drop focus to <body>.
    const heading = document.getElementById('story-type-heading');
    if (heading) heading.focus();
    if (els.savedNote) els.savedNote.hidden = true;
    if (els.saveError) els.saveError.hidden = true;
    if (els.downloadError) els.downloadError.hidden = true;
    if (els.tabConflictWarning) els.tabConflictWarning.hidden = true;
    delete document.body.dataset.theme;
    renderPreview();
  }

  function renderStoryTypeCards() {
    els.storyTypes.innerHTML = '';
    STORY_TYPES.forEach((st) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'story-type-card';
      card.textContent = st.label;
      card.dataset.id = st.id;
      card.setAttribute('aria-pressed', 'false');
      card.addEventListener('click', () => selectStoryType(st.id));
      els.storyTypes.appendChild(card);
    });
  }

  function selectStoryType(id) {
    if (isGeneratingPdf) return;
    // joyfulDetail is the one field id every story type reuses for a
    // DIFFERENT question ("about your birth family" vs "about your
    // surrogate" vs "a milestone" vs "about the family you joined") — unlike
    // travelPlace/travelDuration, which mean the same thing in every type
    // that has them. Carrying its text across a type switch produces content
    // that actively contradicts the rest of the book (e.g. an IVF book
    // mentioning a "birth mom" it never otherwise references), so it must be
    // cleared, not just relabeled, when the story type actually changes.
    if (state.storyType && state.storyType !== id) {
      delete state.answers.joyfulDetail;

      // Every OTHER origin-field id (adoptionPath/birthParentTerm/
      // helperTerm/helperDetail/donorInvolved/howCame/travelPlace/
      // travelDuration) is exclusive to whichever story type(s) declare it
      // in ORIGIN_FIELDS — renderFields() unconditionally writes a default
      // value for every field of the CURRENT type the instant it's even
      // looked at (not just typed into), so merely clicking a different
      // story-type card to peek at it, then switching back, permanently
      // left that type's exclusive fields (e.g. IVF's helperDetail/
      // donorInvolved) sitting in state.answers/localStorage. Inert for the
      // actual book/PDF (every consumer already gates correctly on
      // storyType/adoptionPath), but a real, silent, unbounded
      // accumulation of dead keys that also makes the cross-tab conflict
      // check below flag an otherwise-meaningless diff.
      //
      // The first version of this fix (086969a, earlier today) deleted any
      // OLD-type field the NEW type doesn't also declare, unconditionally —
      // including fields the user had actually filled in, not just
      // never-touched defaults. A fresh-eyes review caught a severe
      // consequence: selecting Adoption, setting adoptionPath to "Foster
      // care", peeking IVF (which has no adoptionPath field) and clicking
      // back to Adoption silently reset adoptionPath to its default ("A
      // birth parent chose us") — a completely different, FALSE narrative
      // for the actual generated book, with zero visible warning. Losing a
      // stray travelPlace string is a nuisance; losing which adoption path
      // is true is a correctness bug this product's own design principles
      // (docs/adoption-language-review.md) exist specifically to prevent.
      //
      // Only clear a field if its current value is STILL exactly what
      // renderFields() auto-wrote (i.e. genuinely untouched) — this still
      // closes the original dead-key case (helperDetail/donorInvolved never
      // interacted with) without destroying anything the user actually
      // chose or typed, even if they're just peeking at another type and
      // come back. Trade-off accepted: a touched-then-abandoned-forever
      // field can still leak as an inert dead key (the original, low-
      // severity problem 086969a set out to fix) — preferred over silent
      // narrative corruption. Found by a fresh-eyes review 2026-07-27.
      const newFieldIds = new Set(getOriginFieldsFor(id).map((f) => f.id));
      getOriginFieldsFor(state.storyType).forEach((f) => {
        if (f.id === 'joyfulDetail' || newFieldIds.has(f.id)) return;
        const current = state.answers[f.id];
        // Mirror getVisibleFields()'s own select-field fallback (f.default
        // || f.options[0]) exactly -- every select field currently defines
        // an explicit default so this never diverges from the simpler `''`
        // fallback in practice, but a future select field added without one
        // would otherwise never be recognized as "untouched" and leak as a
        // dead key forever. Found by a fresh-eyes review 2026-07-27.
        const untouchedValue = f.default !== undefined
          ? f.default
          : (f.type === 'select' && f.options ? f.options[0] : '');
        if (current === untouchedValue || current === undefined) delete state.answers[f.id];
      });
    }
    state.storyType = id;
    state.previewIndex = 0;
    [...els.storyTypes.children].forEach((card) => {
      const isSelected = card.dataset.id === id;
      card.classList.toggle('selected', isSelected);
      card.setAttribute('aria-pressed', String(isSelected));
    });

    const st = STORY_TYPES.find((s) => s.id === id);
    if (!state.titleTouched || state.answers.bookTitle === undefined) {
      state.answers.bookTitle = st.defaultTitle;
    }

    els.formSection.hidden = false;
    if (els.downloadError) els.downloadError.hidden = true;
    // A story-type switch immediately saves (below), so this tab is about to
    // overwrite whatever the other tab wrote — the warning's own "your
    // changes will be overwritten" framing would be stale/backwards if left
    // showing past this point (same reasoning startOver() already applies).
    if (els.tabConflictWarning) els.tabConflictWarning.hidden = true;
    renderFields();
    renderPreview();
    saveProgress();
    document.body.dataset.theme = id;
  }

  // The browser's own maxlength enforcement only applies to user
  // typing/pasting into an <input> — it does NOT constrain a value set
  // programmatically (state.answers[f.id] = value, which restoreSavedProgress()
  // does verbatim from localStorage). A corrupted/hand-edited saved value
  // far longer than its field's own maxLength (e.g. a 300-char childName,
  // 40-char cap) sails through every existing guard and reaches
  // buildPages()/the PDF renderer unclamped — fitTextBlock()'s autofit
  // handles some of those splices gracefully, but any page that renders a
  // field at a FIXED size (e.g. the italic "How X joined our family" label)
  // has no such protection and visibly overlaps the text below it. Same
  // corrupted-localStorage threat model already guarded for every other
  // field (select values, previewIndex, numSiblings, avatar sub-fields,
  // bookTitle) — clamping here, alongside the select-field normalization
  // above, closes it the same way. Found by live testing 2026-07-25.
  function clampTextFieldValue(f) {
    if (f.type === 'text' && f.maxLength && typeof state.answers[f.id] === 'string' && state.answers[f.id].length > f.maxLength) {
      state.answers[f.id] = state.answers[f.id].slice(0, f.maxLength);
    }
  }

  // Builds the full ordered field list for the CURRENT answers, including the
  // dynamic sibling-name fields (count depends on numSiblings) and any
  // showIf-conditional fields (e.g. parentsLabelCustom).
  function getVisibleFields() {
    const fields = getFieldsFor(state.storyType);
    // Normalize any select-type answer that no longer matches its own
    // field's option list (corrupted/hand-edited localStorage, or a future
    // option-list change) BEFORE evaluating any showIf() below — otherwise a
    // stale/invalid value (e.g. adoptionPath: 'unknown-path') can wrongly
    // hide or show a conditional field (birthParentTerm's showIf reads the
    // raw value here), even though the value itself would be silently
    // corrected moments later when its own <select> is actually rendered.
    // numSiblings is excluded: it has its own clamp-to-nearest-bound logic
    // right below (e.g. '99' clamps to '4', the max — not reset to '0',
    // the default — since siblings already named shouldn't be discarded).
    fields.forEach((f) => {
      if (f.type === 'select' && f.id !== 'numSiblings' && !f.options.includes(state.answers[f.id])) {
        state.answers[f.id] = f.default || f.options[0];
      }
    });
    const out = [];
    fields.forEach((f) => {
      if (f.id === 'numSiblings') {
        out.push(f);
        const n = clampSiblingCount(state.answers.numSiblings || f.default || '0');
        // Keep the <select>'s own stored value in sync with the clamp below —
        // otherwise a corrupted/out-of-range saved value (e.g. '7') still gets
        // written verbatim into the <select> (selectedIndex -1, blank display)
        // even though the sibling-name fields it generates are correctly capped.
        state.answers.numSiblings = String(n);
        // Decreasing the count only ever stopped RENDERING the higher-index
        // sibling fields — their old text stayed in state.answers/localStorage
        // untouched. Raising the count back up then silently pre-filled the
        // newly-revealed field with that stale, no-longer-relevant name (e.g.
        // set to 3, type Alex/Beth/Cara, drop to 1, raise back to 2 — the
        // second field reappears already containing "Beth"), indistinguishable
        // in the UI from something the parent just typed, and it flows straight
        // into the live preview and the downloaded PDF. Unlike the story-type
        // field-clearing case, there's no "untouched vs. real" distinction to
        // preserve here — the field simply doesn't exist anymore at this count,
        // so clearing on every decrease is the safe default. Found by a
        // fresh-eyes review 2026-07-27.
        for (let i = n + 1; i <= maxSiblingCount(); i++) {
          delete state.answers['siblingName' + i];
        }
        for (let i = 1; i <= n; i++) {
          const sf = siblingField(i);
          clampTextFieldValue(sf);
          out.push(sf);
        }
        return;
      }
      if (f.showIf && !f.showIf(state.answers)) return;
      clampTextFieldValue(f);
      out.push(f);
    });
    return out;
  }

  // Same corrupted/hand-edited-localStorage threat model already guarded for
  // every other stateful field (select fields normalized in getVisibleFields(),
  // numSiblings/previewIndex/storyType each clamped/validated on restore) —
  // but childAvatar's four sub-keys (skinTone/hairStyle/hairColor/eyeColor)
  // were only ever checked for total absence, not for an invalid id within an
  // existing object. An invalid id (e.g. skinTone: 'purple') silently falls
  // back to AvatarKit's own internal default in the RENDERED avatar
  // (avatar.js's hexFor()), while the swatch-button UI compares against the
  // raw, uncorrected value — so every swatch in that row shows as unselected/
  // aria-pressed="false", desyncing the visible "nothing chosen" UI from the
  // avatar actually being drawn (and that will end up in the PDF). Found by a
  // fresh-eyes review 2026-07-24.
  // childPhoto is always written by cropPhotoToSquare() as a
  // canvas.toDataURL('image/jpeg', ...) string — every OTHER stateful field
  // (previewIndex, numSiblings, storyType, select options, childAvatar's own
  // sub-keys, text-field maxLength) is validated against its known-good
  // shape on restore from localStorage, but childPhoto was only ever checked
  // for truthiness. A corrupted/hand-edited value (same threat model as
  // every guard above) reaches buildPages() as `useAvatar: false` with a
  // garbage `photo` string, so both the live preview and the real PDF show a
  // permanently broken image instead of falling back to the avatar the app
  // otherwise always guarantees when no valid photo exists. Found by a
  // fresh-eyes review 2026-07-27.
  // Restricted to image/jpeg (not image/* generally) because buildAndSaveDoc()
  // unconditionally passes 'JPEG' to jsPDF's addImage() whenever a photo is
  // present -- a well-formed but non-JPEG data URL (e.g. hand-edited storage
  // holding a valid PNG) would pass a looser check, render fine in the live
  // <img> preview, then silently fail to decode in the PDF (caught by the
  // existing try/catch, so no crash, just a missing photo with no visible
  // preview/PDF divergence warning). Found by a fresh-eyes review 2026-07-28.
  function isValidPhotoDataUrl(value) {
    return typeof value === 'string' && /^data:image\/jpeg;base64,/i.test(value);
  }

  function ensureAvatarDefaults() {
    if (!state.answers.childAvatar || typeof state.answers.childAvatar !== 'object') {
      state.answers.childAvatar = Object.assign({}, AvatarKit.DEFAULT_AVATAR);
      return;
    }
    const avatar = state.answers.childAvatar;
    const optionLists = {
      skinTone: AvatarKit.SKIN_TONES,
      hairStyle: AvatarKit.HAIR_STYLES,
      hairColor: AvatarKit.HAIR_COLORS,
      eyeColor: AvatarKit.EYE_COLORS,
    };
    Object.keys(optionLists).forEach((key) => {
      const validIds = optionLists[key].map((opt) => opt.id);
      if (!validIds.includes(avatar[key])) {
        avatar[key] = AvatarKit.DEFAULT_AVATAR[key];
      }
    });
  }

  function renderFields() {
    ensureAvatarDefaults();
    const fields = getVisibleFields();
    // Mirrors the isKinshipAdoption/isBlended/isFosterCare flags in
    // buildPages() — used below to keep two FORM-facing strings (not just
    // the generated book pages, which is where this bug class was
    // previously fixed 8 times) from contradicting the same premise.
    const isKinshipAdoption = state.storyType === 'adoption' && state.answers.adoptionPath === 'Kinship / relative adoption';
    const isBlendedFamily = state.storyType === 'blended';
    const isFosterCareAdoption = state.storyType === 'adoption' && state.answers.adoptionPath === 'Foster care';
    // renderFields() rebuilds every field element from scratch, which would
    // otherwise drop keyboard focus to <body> mid-interaction (e.g. right
    // after changing "how many siblings" or "parents label" — both of
    // which call this function from their own change handler). Restore
    // focus to the same field id afterwards so keyboard/screen-reader users
    // aren't dropped out of the form.
    const focusedId = els.fields.contains(document.activeElement) ? document.activeElement.id : null;
    // Also preserve the caret position, not just which field has focus — an
    // async trigger (e.g. a photo finishing its crop) can call renderFields()
    // while the parent is mid-edit in a completely unrelated text field;
    // without this, focus lands back on the right element but the caret
    // silently jumps to the end, scrambling a mid-string edit in progress.
    let focusedSelection = null;
    if (focusedId && typeof document.activeElement.selectionStart === 'number') {
      focusedSelection = [document.activeElement.selectionStart, document.activeElement.selectionEnd];
    }
    els.fields.innerHTML = '';

    fields.forEach((f) => {
      const wrap = document.createElement('div');
      wrap.className = 'field';

      const label = document.createElement('label');
      // The static label "Where did you travel to meet your child?" directly
      // contradicts the journey page's own generated text for 2 of adoption's
      // 4 paths — Kinship/International already read "...to bring [name]
      // home" and Foster care reads "...to be with [name]" specifically to
      // avoid claiming a first meeting (see buildPages()'s isKinshipAdoption/
      // isFosterCare handling) — yet the question collecting that very answer
      // still asked about "meeting" the child for those same paths. Surrogacy
      // has no path variance (buildOriginSentence's surrogacy branch always
      // reads "...time to meet [parents]", so "meet" is accurate there) and
      // keeps its static label. Found by a fresh-eyes review 2026-07-26.
      let fieldLabel = f.label;
      if (f.id === 'travelPlace' && state.storyType === 'adoption') {
        if (isKinshipAdoption || state.answers.adoptionPath === 'International adoption') {
          fieldLabel = 'Where did you travel to bring your child home?';
        } else if (isFosterCareAdoption) {
          fieldLabel = 'Where did you travel to be with your child?';
        }
      }
      label.textContent = fieldLabel + (f.required ? '' : ' (optional)');
      // The avatar builder is a group of buttons/swatches, not one control
      // with a matching 'field-<id>' element — a `for` here would point at
      // nothing and orphan the label for screen readers and label clicks.
      // Give it an id instead so the group below can reference it via
      // aria-labelledby.
      if (f.type !== 'avatar') {
        label.setAttribute('for', 'field-' + f.id);
      } else {
        label.id = 'field-' + f.id + '-label';
      }
      wrap.appendChild(label);

      // Give the hint an id and wire it up via aria-describedby below —
      // otherwise a screen-reader user who tabs straight into a field
      // (rather than reading the page linearly) never hears it, since DOM
      // proximity to the label alone isn't enough to associate it.
      let hintId = null;
      // "...already waiting to meet this child" is the same "unconditional
      // text contradicts a path's own premise" bug class fixed 8 times in
      // buildPages() — Kinship adoption's own premise is "already loved" (a
      // pre-existing relationship, not a first meeting), Blended family's is
      // two already-existing families merging (no newborn "meeting" at all),
      // and Foster care is deliberately non-committal about timing since the
      // child may have already lived with these siblings for months or
      // years. numSiblings has no showIf — this hint renders unchanged for
      // every story type. Found by a fresh-eyes review 2026-07-26.
      let fieldHint = f.hint;
      if (f.id === 'numSiblings' && (isKinshipAdoption || isBlendedFamily || isFosterCareAdoption)) {
        fieldHint = 'The brothers and sisters already part of this child’s life.';
      }
      if (fieldHint) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.id = 'field-' + f.id + '-hint';
        hint.textContent = fieldHint;
        wrap.appendChild(hint);
        hintId = hint.id;
      }

      if (f.type === 'photo') {
        wrap.appendChild(buildPhotoUpload(f, hintId));
        els.fields.appendChild(wrap);
        return;
      }

      if (f.type === 'avatar') {
        wrap.appendChild(buildAvatarBuilder(f, hintId));
        els.fields.appendChild(wrap);
        return;
      }

      let value = state.answers[f.id] !== undefined ? state.answers[f.id] : (f.default || '');
      let input;
      if (f.type === 'select') {
        // A saved value that doesn't match any of this field's own options
        // (hand-edited/corrupted localStorage, or a future option-list
        // change) would otherwise assign the <select>'s .value to something
        // it has no matching <option> for, silently rendering it blank
        // (selectedIndex -1) — no visible selection, and downstream code
        // that branches on this exact string can also fall through to an
        // unintended default. Fall back to the field's own default instead.
        if (!f.options.includes(value)) value = f.default || f.options[0];
        input = document.createElement('select');
        f.options.forEach((opt) => {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        });
      } else {
        input = document.createElement('input');
        input.type = 'text';
        // Every free-text field's box otherwise renders as a plain LTR
        // paragraph (unicode-bidi:normal, text-align:start resolving to
        // left) regardless of what's typed — a name/phrase in an
        // RTL-dominant script (Arabic, Hebrew) then reads as left-aligned,
        // the opposite of what a native reader of that script expects,
        // even though the app already goes out of its way to correctly
        // bidi-isolate the SAME text once it reaches the read-only preview
        // label (2026-07-18). `dir="auto"` auto-detects direction from the
        // field's own first strong-direction character with zero effect on
        // ordinary Latin-script input. Found by a fresh-eyes live check
        // 2026-07-26.
        input.dir = 'auto';
        if (f.id === 'bookTitle') {
          const st = STORY_TYPES.find((s) => s.id === state.storyType);
          input.placeholder = (st && st.defaultTitle) || f.placeholder || '';
        } else if (f.id === 'joyfulDetail' && state.storyType === 'adoption') {
          // The static placeholder hardcoded "birth mom" regardless of the
          // dedicated birthParentTerm select right above it — a parent who
          // picks "birth family"/"birth parents" still saw the one specific
          // term the app otherwise goes out of its way to make optional
          // (buildOriginSentence already reads birthParentTerm dynamically
          // the same way). Found by a fresh-eyes review 2026-07-23.
          //
          // birthParentTerm only APPLIES to the default adoptionPath
          // (buildOriginSentence's own gating, mirrored here) — its select
          // is hidden for Foster care/International/Kinship, but
          // state.answers.birthParentTerm still holds its last value (every
          // select gets defaulted into state.answers the moment it first
          // renders), so the fix above alone kept splicing a stale/hidden
          // "birth mom" into the placeholder for those three paths, exactly
          // the misrepresentation prompts.js's own field comment warns
          // against. Found by a second fresh-eyes review the same day.
          const path = state.answers.adoptionPath || 'A birth parent chose us';
          const term = path === 'A birth parent chose us' ? (state.answers.birthParentTerm || 'birth mom') : 'birth family';
          input.placeholder = 'e.g. Your ' + term + ' loves music, just like you do.';
        } else {
          input.placeholder = f.placeholder || '';
        }
        if (f.maxLength) input.maxLength = f.maxLength;
      }
      input.id = 'field-' + f.id;
      input.value = value;
      if (hintId) input.setAttribute('aria-describedby', hintId);
      // The only signal a field is mandatory used to be that its label omits
      // "(optional)" — a screen-reader user tabbing directly into a field
      // (rather than reading the label text first) got no indication of
      // that. There's no <form> element anywhere in this app (every action
      // is a plain button click), so the native `required` attribute has no
      // side effect here beyond the accessibility signal it's meant for.
      if (f.required) {
        input.required = true;
        input.setAttribute('aria-required', 'true');
      }
      state.answers[f.id] = value;

      // A newline pasted or dropped into ANY single-line text field is
      // silently stripped by the browser's own value-sanitization
      // algorithm before any 'input' event fires — even a direct
      // `.value =` assignment loses it with no trace (verified live:
      // setting "I love you, Ava!\nXO, Mom" produces
      // "I love you, Ava!XO, Mom", fusing the two lines with zero
      // separator). Every prior fix here (2026-07-24 through 2026-07-26)
      // only ever intercepted this for parentsLabelCustom, since that
      // field's comma-based list-parsing was the immediate motivation —
      // but the underlying browser behavior is universal, and a fused
      // two-line paste is a real, visible defect in every other free-text
      // field too (a two-line sign-off or pet name pasted from a Notes
      // app, a title copied from two lines). Generalized to every text
      // field: parentsLabelCustom keeps its existing comma-joining +
      // separator-aware boundary logic (a real delimited list); every
      // other field just joins with a single space (the natural word/line
      // separator — no list-parsing concern for free prose). Found by a
      // fresh-eyes live check 2026-07-26.
      if (f.type !== 'select') {
        const isParentsList = f.id === 'parentsLabelCustom';
        // Dragging text (not just pasting it) hits the exact same native
        // newline-stripping-with-no-trace behavior the paste handler below
        // exists to prevent — a plain <input>'s value sanitization applies
        // identically whether the multi-line text arrives via Ctrl/Cmd-V or
        // a native drag-and-drop (e.g. dragging two selected rows from a
        // spreadsheet, or two lines from a Notes window, directly onto this
        // field — an ordinary browser interaction). The window-level drop
        // guard (see init() above) only ever prevents FILE drops outside
        // the file input; it deliberately leaves ordinary text drops alone,
        // so nothing else catches this. Both events expose the same raw
        // pre-sanitization text via DataTransfer's getData('text/plain'),
        // so one shared handler covers both.
        const applyMultilineText = (e, rawText) => {
          if (!/[\r\n]/.test(rawText)) return;
          e.preventDefault();
          // Consume horizontal whitespace immediately touching the newline
          // run, not just the newline itself — a very common real-world
          // clipboard artifact (a trailing space before the line break, from
          // Notes apps / email signatures / spreadsheet cells) otherwise
          // survives INSIDE `sanitized` and collides with the substituted
          // separator, baking a literal double space into the field. Looks
          // completely correct in the live preview (HTML collapses
          // whitespace) but renders as a visibly wider gap in the real
          // downloaded PDF, where jsPDF's doc.text() does not collapse it.
          // Found by a fresh-eyes review 2026-07-28.
          let sanitized = rawText.replace(/[ \t]*[\r\n]+[ \t]*/g, isParentsList ? ', ' : ' ');
          const start = input.selectionStart;
          const end = input.selectionEnd;
          let before = input.value.slice(0, start);
          let after = input.value.slice(end);
          if (isParentsList) {
            // A leading or trailing newline in the pasted text (a realistic
            // artifact — many apps include one when a whole line/column is
            // copied, e.g. "Grandma\nGrandpa\n") collapses to a dangling ", "
            // at the edge of `sanitized`. When that side of the paste is
            // genuinely empty, it's just stray noise — trim it so the
            // visible box doesn't show leftover punctuation a parent might
            // mistake for a real (and now-lost) entry.
            if (before === '') sanitized = sanitized.replace(/^,\s*/, '');
            if (after === '') sanitized = sanitized.replace(/,\s*$/, '');
            // But when that side is NOT empty — e.g. appending "Auntie\n"
            // right after already-typed "Grandma and Grandpa" — the artifact
            // just trimmed above WAS the only thing standing between the old
            // and new content; removing it (or never having one at all, for
            // a paste with no boundary newline) fuses them into one garbled
            // pseudo-name ("GrandpaAuntie") that getParentsList() can't
            // split apart. Insert a real separator at the boundary whenever
            // real content butts up against real content with none already
            // there. Plain whitespace doesn't count as "already separated"
            // here — getParentsList() only splits on ,&;/ or the word
            // "and", not bare spaces. Found by a fresh-eyes review
            // 2026-07-25, following up the same-day dangling-artifact trim
            // above (which alone doesn't fix this — it only ever removes
            // noise, it never restores a separator the trim itself removed).
            // The word "and" is just as valid a separator as ,;&/ — getParentsList()
            // already treats it as one (`.replace(/\band\b/gi, ',')`), and this
            // very function relies on that fact in its own comment above. Missing
            // it here meant appending "Grandpa\n" right after already-typed
            // "Grandma and " (a very natural thing to type) saw no separator at
            // the boundary and inserted a redundant one, producing the visibly
            // wrong, permanently-saved "Grandma and , Grandpa". Found by a
            // fresh-eyes review 2026-07-26.
            const sepEnd = /(?:[,;&/]|\band\b)\s*$/i;
            const sepStart = /^\s*(?:[,;&/]|\band\b)/i;
            // .trim() here, not bare truthiness — `before`/`after` made up
            // ENTIRELY of whitespace (e.g. a single accidental space typed
            // into an otherwise-empty field) is non-empty but has no real
            // content to separate from. Testing raw truthiness inserted a
            // synthetic separator next to nothing — e.g. a lone leading
            // space plus a two-line paste produced ", Grandma, Grandpa"
            // (stray leading comma), or trailing spaces after "Grandma"
            // produced "Grandma, Aunt, Uncle, " (dangling trailing comma).
            // Found by a fresh-eyes review 2026-07-26.
            if (before.trim() && !sepEnd.test(before) && !sepStart.test(sanitized)) {
              // Bare trailing whitespace with no real separator (e.g. a
              // parent typed "Grandma " and paused) isn't itself a
              // separator — trim it before inserting the synthetic ", " so
              // the two don't glue into a stray "Grandma , Auntie" instead
              // of "Grandma, Auntie". Found by a fresh-eyes review 2026-07-26.
              before = before.replace(/[ \t]+$/, '');
              sanitized = ', ' + sanitized;
            } else if (sepEnd.test(before) && !/\s$/.test(before)) {
              // `before` already ends in a real separator ("Grandma," or
              // "Grandma and") but with no trailing space — e.g. the caret
              // sits right after the comma. Skipping insertion entirely (the
              // branch above) is correct — a second ", " would double up the
              // punctuation ("Grandma,, Cousin") — but leaving it as-is glues
              // the pasted text directly onto the existing punctuation
              // ("Grandma,Cousin"). Add just the missing space. Found by a
              // fresh-eyes review 2026-07-26.
              before = before + ' ';
            }
            if (after.trim() && !sepStart.test(after) && !sepEnd.test(sanitized)) {
              after = after.replace(/^[ \t]+/, '');
              sanitized = sanitized + ', ';
            } else if (sepStart.test(after) && !/^\s/.test(after)) {
              // Symmetric case: `after` already starts with a separator but
              // has no leading space (e.g. the caret sits right before
              // "&Grandpa"). Found by a fresh-eyes review 2026-07-26.
              after = ' ' + after;
            }
          } else {
            // General free-text field: there's no delimited-list semantics
            // to preserve, just avoid an accidental double space where the
            // paste lands right next to already-existing whitespace.
            if (before === '' || /\s$/.test(before)) sanitized = sanitized.replace(/^ /, '');
            if (after === '' || /^\s/.test(after)) sanitized = sanitized.replace(/ $/, '');
          }
          const combined = before + sanitized + after;
          // Programmatically assigning .value (unlike typing or a native
          // single-line paste) is NOT subject to the maxlength attribute —
          // the browser only enforces that on user-driven edits. Without
          // this slice, a multi-line paste (several caregiver names, one
          // per line — the exact scenario this handler exists for) could
          // silently blow straight past the field's own maxLength, the
          // same safety net every other field's input relies on to bound
          // PDF layout. Found by a fresh-eyes review 2026-07-24.
          const max = input.maxLength > 0 ? input.maxLength : combined.length;
          input.value = combined.slice(0, max);
          // Derived from the (possibly trimmed) `before`/`sanitized`
          // lengths rather than the original `start`, since trimming
          // trailing whitespace off `before` above shifts where the
          // inserted text actually lands.
          const newPos = Math.min(before.length + sanitized.length, input.value.length);
          input.setSelectionRange(newPos, newPos);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        input.addEventListener('paste', (e) => {
          const clip = e.clipboardData || window.clipboardData;
          applyMultilineText(e, clip ? clip.getData('text/plain') : '');
        });
        // A native drop (unlike this app's own paste handler above, which
        // intercepts before any browser insertion happens) would otherwise
        // insert at wherever the browser judges the drop point to be, not
        // necessarily the field's last-known selection — focusing first
        // keeps this handler's insert-at-selection behavior consistent with
        // the paste path rather than silently landing text somewhere the
        // caret was never actually placed.
        input.addEventListener('drop', (e) => {
          input.focus();
          applyMultilineText(e, e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
        });
      }

      // A single 'input' listener is enough — <select> fires both 'input' and
      // 'change' natively in all evergreen browsers, so listening to both
      // used to run the whole onFieldChange pipeline (state write, a
      // conditional renderFields() DOM rebuild, renderPreview(),
      // saveProgress()) twice per selection.
      input.addEventListener('input', onFieldChange(f, input));

      wrap.appendChild(input);
      els.fields.appendChild(wrap);
    });

    if (focusedId) {
      let toFocus = document.getElementById(focusedId);
      // A field can rebuild into a state where the same id is now hidden —
      // e.g. "Remove photo" only exists while a photo is set, so removing
      // one makes its own id disappear from view. Fall back to the file
      // input it sits next to, the next logical control for that field.
      if (toFocus && toFocus.hidden && focusedId.endsWith('-remove')) {
        toFocus = document.getElementById(focusedId.slice(0, -'-remove'.length));
      }
      if (toFocus) {
        toFocus.focus();
        if (focusedSelection && typeof toFocus.setSelectionRange === 'function') {
          toFocus.setSelectionRange(focusedSelection[0], focusedSelection[1]);
        }
      }
    }
  }

  // Builds the file-input + thumbnail + remove-button control for a 'photo'
  // field. Handled separately from the generic select/text inputs above
  // because a <input type=file> can't be pre-filled with a value — the
  // stored data URL lives only in state.answers.childPhoto.
  function buildPhotoUpload(f, hintId) {
    const uploadWrap = document.createElement('div');
    uploadWrap.className = 'photo-upload';
    // A corrupted/hand-edited stored value (same threat model as every other
    // restore guard) would otherwise show a permanently broken image icon
    // with no way to recover except "Remove photo" — drop it silently and
    // fall through to the no-photo/avatar state instead, same as
    // buildPages()'s own guard.
    if (state.answers[f.id] && !isValidPhotoDataUrl(state.answers[f.id])) {
      delete state.answers[f.id];
    }
    const current = state.answers[f.id];

    const thumb = document.createElement('img');
    thumb.className = 'photo-thumb';
    thumb.alt = "Your uploaded photo of your child";
    thumb.hidden = !current;
    if (current) thumb.src = current;
    uploadWrap.appendChild(thumb);

    const errorMsg = document.createElement('p');
    errorMsg.className = 'photo-upload-error';
    errorMsg.id = 'field-' + f.id + '-error';
    // Only mark this a live role="alert" region when the current error
    // occurrence hasn't already been announced once (see
    // photoUploadErrorAnnounced's own comment) — otherwise every unrelated
    // renderFields() rebuild while the error stays showing would insert a
    // brand-new alert node already containing the visible text, which most
    // screen readers treat as a fresh alert and re-announce. The genuine
    // first reveal (below, where photoUploadErrorAnnounced[f.id] is set
    // true) still gets role="alert" here so it announces correctly once.
    if (!photoUploadErrorAnnounced[f.id]) {
      errorMsg.setAttribute('role', 'alert');
    }
    // Reflects whatever the last upload attempt for this field actually did
    // (see photoUploadErrorShown's own comment) rather than always starting
    // hidden — otherwise any unrelated renderFields() rebuild while an error
    // is showing would silently discard it.
    errorMsg.hidden = !photoUploadErrorShown[f.id];
    errorMsg.textContent = "That file couldn't be used as a photo — please try a JPG or PNG image.";

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.id = 'field-' + f.id;
    if (hintId) fileInput.setAttribute('aria-describedby', hintId);
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      errorMsg.hidden = true;
      photoUploadErrorShown[f.id] = false;
      photoUploadErrorAnnounced[f.id] = false;
      const mySeq = (photoUploadSeq[f.id] = (photoUploadSeq[f.id] || 0) + 1);
      // Disable Download for the duration of this crop — see
      // pendingPhotoUploads' own comment for why.
      pendingPhotoUploads++;
      renderPreview();
      cropPhotoToSquare(
        file,
        (dataUrl) => {
          pendingPhotoUploads--;
          // A newer upload for this same field started (and possibly
          // already finished) while this one was still processing —
          // discard this stale result instead of clobbering it.
          if (photoUploadSeq[f.id] !== mySeq) { renderPreview(); return; }
          state.answers[f.id] = dataUrl;
          renderFields();
          renderPreview();
          saveProgress();
        },
        () => {
          pendingPhotoUploads--;
          if (photoUploadSeq[f.id] !== mySeq) { renderPreview(); return; }
          // Look these up fresh by id instead of trusting the fileInput/
          // errorMsg closures — an unrelated field change (numSiblings/
          // parentsLabel/adoptionPath) can trigger a renderFields() DOM
          // rebuild while this crop is still in flight, which detaches the
          // originals from the page. Writing to the detached elements
          // silently produced no visible error at all.
          const liveInput = document.getElementById('field-' + f.id);
          const liveError = document.getElementById('field-' + f.id + '-error');
          photoUploadErrorShown[f.id] = true;
          photoUploadErrorAnnounced[f.id] = true;
          if (liveInput) liveInput.value = '';
          if (liveError) liveError.hidden = false;
          renderPreview();
        }
      );
    });
    uploadWrap.appendChild(fileInput);
    uploadWrap.appendChild(errorMsg);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'link-btn';
    removeBtn.id = 'field-' + f.id + '-remove';
    removeBtn.textContent = 'Remove photo';
    removeBtn.hidden = !current;
    removeBtn.addEventListener('click', () => {
      // Invalidate any still-in-flight upload for this field so it can't
      // resolve after the removal and silently bring the photo back.
      photoUploadSeq[f.id] = (photoUploadSeq[f.id] || 0) + 1;
      photoUploadErrorShown[f.id] = false;
      photoUploadErrorAnnounced[f.id] = false;
      delete state.answers[f.id];
      renderFields();
      renderPreview();
      saveProgress();
    });
    uploadWrap.appendChild(removeBtn);

    return uploadWrap;
  }

  // Reads an image file, center-crops it to a square, and downsizes it so the
  // resulting data URL is small enough to live comfortably in localStorage
  // alongside the rest of the answers (a few hundred KB at most). 625px is
  // sized for the PDF's 150pt cover circle at true 300 DPI print quality
  // (same reasoning as the avatar/portrait scenes — see avatarSceneFor).
  // `accept="image/*"` on the file input doesn't stop someone from picking
  // "All Files" and choosing something that isn't actually an image — without
  // these error handlers, the reader/Image simply never fire onload and the
  // button looks like it silently did nothing.
  function cropPhotoToSquare(file, onDone, onError) {
    const reader = new FileReader();
    reader.onerror = () => onError();
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => onError();
      img.onload = () => {
        // A degenerate (0x0) image — e.g. an SVG with explicit width="0"
        // height="0" — fires onload, not onerror, but Canvas's drawImage()
        // silently no-ops on a zero-size source rect instead of throwing.
        // Without this check, onDone() would fire with nothing but the
        // opaque white fill below: a blank square baked onto the book's
        // cover with no error shown anywhere.
        if (img.width === 0 || img.height === 0) { onError(); return; }
        const size = 625;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        // JPEG output has no alpha channel — without an explicit opaque
        // background, transparent areas of a source PNG/GIF/WebP (e.g. a
        // sticker or a screenshot) get flattened to solid black instead of
        // reading as "no photo there," in both the live preview and the PDF.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        onDone(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // Builds the swatch/style-button UI for the 'avatar' field. Every change
  // updates state.answers.childAvatar in place, then re-renders the small
  // thumbnail here plus the book preview — mirroring buildPhotoUpload's
  // update pattern above.
  function buildAvatarBuilder(f, hintId) {
    ensureAvatarDefaults();
    const avatar = state.answers.childAvatar;
    const wrap = document.createElement('div');
    wrap.className = 'avatar-builder';
    // Not one control like a text input/file input — apply the hint at the
    // group level so screen readers announce it when entering the group,
    // even though it isn't re-announced per individual swatch button.
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-labelledby', 'field-' + f.id + '-label');
    if (hintId) wrap.setAttribute('aria-describedby', hintId);

    const thumb = document.createElement('img');
    thumb.className = 'avatar-thumb';
    thumb.alt = "Preview of your child's avatar";
    const refreshThumb = () => { thumb.src = AvatarKit.renderScene('face', avatar, 160, {}); };
    refreshThumb();
    wrap.appendChild(thumb);

    function optionRow(label, options, key, className, render) {
      const row = document.createElement('div');
      row.className = 'avatar-row';
      const rowLabel = document.createElement('span');
      rowLabel.className = 'avatar-row-label';
      rowLabel.textContent = label;
      row.appendChild(rowLabel);
      const group = document.createElement('div');
      group.className = className;
      options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        // renderFields()'s focus-restore logic (used whenever an unrelated
        // field change or an async photo-crop finishing rebuilds the whole
        // form) looks up the previously-focused element by id — with no id
        // here, a parent mid-click on an avatar swatch/style button would
        // silently lose focus to <body> on any rebuild.
        btn.id = 'avatar-' + key + '-' + opt.id;
        render(btn, opt);
        btn.classList.toggle('selected', avatar[key] === opt.id);
        btn.setAttribute('aria-pressed', String(avatar[key] === opt.id));
        btn.addEventListener('click', () => {
          avatar[key] = opt.id;
          [...group.children].forEach((b) => {
            b.classList.remove('selected');
            b.setAttribute('aria-pressed', 'false');
          });
          btn.classList.add('selected');
          btn.setAttribute('aria-pressed', 'true');
          refreshThumb();
          renderPreview();
          saveProgress();
        });
        group.appendChild(btn);
      });
      row.appendChild(group);
      return row;
    }

    wrap.appendChild(optionRow('Skin tone', AvatarKit.SKIN_TONES, 'skinTone', 'swatch-row', (btn, opt) => {
      btn.className = 'swatch';
      btn.style.background = opt.hex;
      btn.setAttribute('aria-label', 'Skin tone: ' + opt.id);
    }));
    wrap.appendChild(optionRow('Hair style', AvatarKit.HAIR_STYLES, 'hairStyle', 'style-btn-row', (btn, opt) => {
      btn.className = 'style-btn';
      btn.textContent = opt.label;
    }));
    wrap.appendChild(optionRow('Hair color', AvatarKit.HAIR_COLORS, 'hairColor', 'swatch-row', (btn, opt) => {
      btn.className = 'swatch';
      btn.style.background = opt.hex;
      btn.setAttribute('aria-label', 'Hair color: ' + opt.id);
    }));
    wrap.appendChild(optionRow('Eye color', AvatarKit.EYE_COLORS, 'eyeColor', 'swatch-row', (btn, opt) => {
      btn.className = 'swatch';
      btn.style.background = opt.hex;
      btn.setAttribute('aria-label', 'Eye color: ' + opt.id);
    }));

    return wrap;
  }

  // Rasterizes the current avatar into a scene ('face' | 'baby' | 'family')
  // at the given pixel size, themed to match the selected story type. Used
  // by both renderPreview() (as an <img> src) and downloadBook() (as a
  // jsPDF addImage source) — same PNG data URL either way.
  function avatarSceneFor(kind, size) {
    ensureAvatarDefaults();
    const a = state.answers;
    const theme = themeFor(state.storyType);
    const parents = getParentsList(a);
    const siblings = getSiblingNames(a);
    return AvatarKit.renderScene(kind, a.childAvatar, size, {
      theme: theme,
      parentCount: parents.length,
      siblingCount: siblings.length,
    });
  }

  // A pasted value can carry control characters (e.g. a tab — it survives
  // even though pressing the Tab key just moves focus, a real scenario when
  // copying two names out of adjacent spreadsheet cells) or Unicode line/
  // paragraph separators (U+2028/U+2029 — a real paste artifact from some
  // rich-text/word-processor sources) that a single-line <input> doesn't
  // strip on its own. jsPDF's standard font has no glyph for most of these,
  // so instead of rendering as whitespace they come out as a wrong, visible
  // glyph (e.g. U+2028 rendered as a stray "(") or, for a raw tab, a large
  // blank gap — normalize all of them to a plain space before they reach
  // state. \p{Cc} covers the ASCII/C1 control-character range this used to
  // hardcode as \x00-\x1f\x7f; \p{Zl}/\p{Zp} cover U+2028/U+2029 specifically
  // (the same categories collectUnsupportedGlyphs() already treats as
  // invisible-but-unsupported for the charset warning).
  // .normalize('NFC') collapses a decomposed accented character (base
  // letter + separate combining mark, e.g. "i" + U+0301 — a real paste
  // artifact from some clipboard/IME sources) into its precomposed form
  // ("í", U+00ED). Precomposed Latin-1 accents are within jsPDF's
  // standard-font support and render correctly; the decomposed form's
  // combining mark alone is not, so without this a name that LOOKS
  // identical in the preview would render broken in the PDF and trip
  // collectUnsupportedGlyphs()'s warning for no reason a parent could
  // see or fix.
  function sanitizeTextValue(str) {
    // \p{Cf} ("Format") covers zero-width space/joiner/non-joiner, soft
    // hyphen, and bidi marks — genuinely invisible, zero-width characters a
    // parent can't see or intentionally type (typically clipboard artifacts
    // from Docs/Notion/messaging apps). Unlike \p{Cc}/\p{Zl}/\p{Zp} above,
    // these are removed outright rather than turned into a space: replacing
    // a zero-width character with a visible space would insert space where
    // none was perceived (e.g. a soft hyphen mid-word, "Sar­ah", must
    // collapse back to "Sarah", not "Sar ah"). Without this, a value made
    // up ENTIRELY of invisible format characters (e.g. a single pasted
    // zero-width space) survived every truthiness/`.trim()` blank check in
    // the app unchanged — passing required-field validation and splicing an
    // invisible "name" into the book with no visible content and no error.
    // Found by a fresh-eyes review 2026-07-25.
    return str.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\p{Cf}/gu, '').normalize('NFC');
  }

  // parentsLabelCustom is the one field whose value later gets SPLIT into
  // multiple names (getParentsList(), below) using ,&;/ and the word "and"
  // as separators. A literal tab pasted from adjacent spreadsheet cells
  // (e.g. "Grandma<TAB>Grandpa" — a realistic way to enter two names at
  // once) is a real separator here, but sanitizeTextValue()'s generic
  // control-character-to-space substitution (added 2026-07-20 to fix a
  // different bug: a raw tab rendering as a large blank gap in the PDF)
  // collapses it to a single space — indistinguishable from a real
  // two-word name like "Uncle Bob" — silently fusing two caregivers into
  // one garbled pseudo-person with no warning. Converting a tab to a comma
  // specifically for this one field, before the general sanitizer runs,
  // keeps it as a real separator getParentsList() already recognizes,
  // without changing tab-handling for every other field (childName etc.
  // correctly keep becoming a plain space). Found by a fresh-eyes review
  // 2026-07-24.
  function sanitizeFieldValue(id, value) {
    const withSeparators = id === 'parentsLabelCustom' ? value.replace(/\t/g, ',') : value;
    return sanitizeTextValue(withSeparators);
  }

  function onFieldChange(f, input) {
    return (event) => {
      if (f.id === 'bookTitle') state.titleTouched = true;
      const sanitized = sanitizeFieldValue(f.id, input.value);
      state.answers[f.id] = sanitized;
      // sanitizeFieldValue() can change MEANING, not just invisible cleanup —
      // most notably a tab pasted into parentsLabelCustom (from adjacent
      // spreadsheet cells) becomes a comma separator, so getParentsList()
      // reads it correctly and the saved/downloaded book is already right —
      // but without this, the visible <input> box itself kept showing the
      // raw tab (a wide blank gap, not a separator) indefinitely, since
      // nothing resyncs input.value after a normal keystroke/native paste
      // (only the initial render and the dedicated multi-line-paste handler
      // ever write to it). A parent seeing their two names visually fused
      // could "fix" already-correct saved data by retyping. Guarded on an
      // actual difference so every other field's untouched keystrokes don't
      // needlessly reset the caret, and on setSelectionRange existing since
      // this function is also used for <select> elements (no notion of a
      // text caret — sanitizeTextValue() is a no-op on their option-text
      // values in practice, but don't rely on that to avoid a crash). Found
      // by a fresh-eyes review 2026-07-25.
      //
      // event.isComposing guards against a second, distinct problem: while
      // an IME composition is still open (Vietnamese Telex/VNI, dead-key
      // diacritic input methods commonly used for accented names), the
      // browser dispatches intermediate 'input' events whose value can
      // legitimately be a decomposed accent sequence that sanitizeTextValue()'s
      // NFC normalization then diffs against — forcibly reassigning
      // input.value/setSelectionRange mid-composition is a well-documented
      // way to corrupt or prematurely terminate that composition session
      // (the same reason React/Vue skip value-syncing between
      // compositionstart/compositionend). Skipping the rewrite here is safe:
      // the browser fires one more 'input' event with isComposing:false right
      // after compositionend, which re-runs this same sync once composition
      // has actually finished. Found by a fresh-eyes review 2026-07-25.
      if (!(event && event.isComposing) && sanitized !== input.value && typeof input.setSelectionRange === 'function') {
        const pos = Math.min(input.selectionStart, sanitized.length);
        input.value = sanitized;
        input.setSelectionRange(pos, pos);
      }
      // numSiblings/parentsLabel/adoptionPath changes may add/remove dependent
      // fields; birthParentTerm changes joyfulDetail's placeholder (see the
      // f.id === 'joyfulDetail' branch above) — without a rebuild, switching
      // it from the default "birth mom" wouldn't update the still-empty
      // joyfulDetail field's placeholder until some other field happened to
      // trigger one.
      if (f.id === 'numSiblings' || f.id === 'parentsLabel' || f.id === 'adoptionPath' || f.id === 'birthParentTerm') {
        renderFields();
      }
      renderPreview();
      saveProgress();
    };
  }

  // The book's shared page.text/page.label strings mix plain English prose
  // with whatever a parent typed (e.g. an Arabic or Hebrew name). Two
  // separate, preview-only display fixes for that combination:
  //
  // 1. isolateRtlForDisplay() wraps each RTL script run in FSI/PDI isolate
  //    marks (the same technique <bdi> uses) — standard Unicode bidi
  //    practice so a following ASCII word/punctuation can't get reordered
  //    relative to the RTL run.
  // 2. hasRtlScript() flags when a page.label contains RTL text so
  //    renderPreview() can drop the italic styling .page-label-inline
  //    otherwise always uses. This is the fix for a real, reproducible
  //    visual bug found live: a name like "أحمد الطيب" inside an
  //    *italicized* label ("How أحمد الطيب joined our family") rendered
  //    with what looked like a stray "/" at the RTL/LTR boundary whenever
  //    the line wrapped there — a browser synthetic-italic-slant artifact
  //    at a bidi direction change, confirmed by the glitch disappearing
  //    with font-style:normal and persisting even with the isolate marks
  //    from (1) alone. .page-text (the body copy) isn't italicized, so it
  //    was never affected.
  //
  // Both must stay preview-only: these strings also feed the PDF's
  // doc.text() calls and collectUnsupportedGlyphs(), and jsPDF's font
  // can't render the isolate marks either — the PDF path already has its
  // own honest "won't render" warning for non-Latin scripts.
  function isolateRtlForDisplay(str) {
    // ֐-ࣿ spans Hebrew, Arabic, Syriac, Thaana, N'Ko, and Arabic
    // Extended-A — the RTL scripts realistically reachable via user input.
    // ⁨/⁩ are FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE —
    // zero-width, no glyph of their own.
    return str.replace(/[֐-ࣿ]+/g, '⁨$&⁩');
  }

  function hasRtlScript(str) {
    return /[֐-ࣿ]/.test(str);
  }

  // Several free-text fields (pet name, travel duration/place, IVF's "how
  // did you get help" phrase) get spliced mid-sentence rather than shown as
  // their own standalone page — a trailing period a parent naturally typed
  // ("Biscuit.", "2 weeks.") then produced a doubled/misplaced period, e.g.
  // "a pet named Biscuit.." or "— 2 weeks. of waiting and love". Also strips
  // a trailing Unicode ellipsis ("…", U+2026) — a real terminal-punctuation
  // character this product's own copy already treats as supported (see
  // WINANSI_EXTRA below), so a parent typing "2 weeks…" hit the exact same
  // "a pet named Buddy…." glued-punctuation bug the ASCII case was fixed
  // for. Also strips a trailing colon ("Sam:") — a plausible trailing-off
  // typo that hit the identical glued-punctuation shape ("Sam:, ready for
  // the world.") but was missed when the character class was first written.
  // Found by a fresh-eyes review 2026-07-26. Only strips from the END of
  // the string, so it's safe to apply even
  // to values that happen to already read fine (nothing to strip). Fields
  // that ARE shown as their own complete sentence (joyfulDetail, promise,
  // signOff) intentionally keep whatever punctuation the parent wrote.
  //
  // Also strips any whitespace immediately before the punctuation (e.g.
  // "Maya ." or "Biscuit ."), not just the punctuation itself — every call
  // site does stripTrailingPunctuation(x.trim()), and trim() only removes
  // whitespace at the very edges, so a space *before* a trailing period
  // survives trim() untouched. That leftover space is invisible in the
  // live preview (plain HTML text flow collapses runs of whitespace) but
  // renders literally in the PDF (jsPDF's doc.text() does not collapse
  // whitespace) — "Maya , ready for the world." / "held Maya ." — the
  // exact "looks right in preview, wrong in the real PDF" failure mode
  // found live via a fresh-eyes review 2026-07-22.
  //
  // The trailing run being stripped can itself repeat as (whitespace +
  // punctuation) more than once — e.g. "Maya! ." (an "!" a parent typed,
  // then a "." added afterward with a stray space) or "Sam. !" — a regex
  // that only matches ONE such whitespace+punctuation cluster at the very
  // end would strip only the trailing " .", leaving "Maya!" — still ending
  // in punctuation — which reproduces the exact glued-punctuation bug this
  // function exists to prevent one splice later: "Maya!, ready for the
  // world." on the baby-portrait page. Confirmed live in both the preview
  // and a real downloaded PDF. Found by a fresh-eyes review 2026-07-26.
  //
  // The character class also covers straight and curly quote marks
  // ("'"“”‘’) — a plausible paste artifact (a name copied out of a quoted
  // document, or a trailing quote left over from "Maya") produced the same
  // glued-punctuation bug this function exists to prevent: "Maya", ready
  // for the world." Confirmed live and in a real downloaded PDF. Found by
  // a fresh-eyes review 2026-07-26.
  //
  // An EARLIER version of this fix wrapped the whole (whitespace +
  // punctuation-run) pattern in a group that itself repeats —
  // `(?:\s*[...]+)+$` — to consume every such trailing cluster in one
  // pass. That introduced a severe ReDoS (catastrophic regex
  // backtracking): a nested quantifier where the inner alternative can
  // also be satisfied one character at a time, wrapped in an outer `+`,
  // is exponential-time on a long homogeneous run that doesn't reach the
  // true string end (measured: a 31-character pathological string — well
  // under this function's callers' own maxLength caps — took over 90
  // seconds; each additional character multiplies the time roughly 7x).
  // Since renderPreview() (which calls this indirectly via buildPages())
  // runs on every keystroke, a single such value in ANY covered field
  // would freeze the tab on every subsequent interaction anywhere in the
  // form, not just edits to that field. A single flat character class
  // combining whitespace and punctuation has no such ambiguity (there's
  // only one way to partition a flat `+` match) and is linear-time, and is
  // behaviorally identical here because every call site passes an
  // already-`.trim()`ed string — the true end of the string is guaranteed
  // non-whitespace, so the flat class can never strip a "trailing"
  // whitespace-only run the nested version wouldn't also have stripped
  // (nested requires each cluster to end in punctuation, but any bare
  // trailing whitespace was already removed by `.trim()` before this
  // function ever sees it). Found by a fresh-eyes review 2026-07-26.
  // This function's own extensive fix history (above) only ever addressed
  // the TRAILING side — but the quote-mark case it was extended to cover
  // (2026-07-26, "a name copied out of a quoted document") is exactly the
  // scenario most likely to leave a matching LEADING quote too, since
  // quotes come in pairs. A leading `"` with no matching leading-strip
  // survived untouched and got spliced verbatim into nearly every page —
  // `"Zoe` instead of `Zoe` — passing allRequiredFilled()'s own check
  // (stripTrailingPunctuation('"Zoe') is still truthy) with no warning.
  // Reuses the same flat, non-nested character class as the trailing
  // strip (see the ReDoS note above) for the same linear-time reason;
  // anchored to the start instead of the end. Found by a fresh-eyes
  // review 2026-07-27.
  //
  // The character class was missing hyphens/dashes (-, en dash –, em
  // dash —) despite this app's own copy using em dashes routinely (the
  // "journey" page builds '... traveled — ' + duration + ' of waiting
  // and love ...'). A trailing/leading dash is a plausible paste
  // artifact (a name copied out of a bulleted list, "- Biscuit"; a
  // duration typed as "2 weeks—") and produced the exact same
  // glued-punctuation bug this function exists to prevent: "traveled —
  // 2 weeks— of waiting" and "a pet named - Biscuit." Confirmed live and
  // in a real downloaded PDF. Found by a fresh-eyes review 2026-07-27.
  //
  // Every fix above treats a trailing period as redundant sentence-closer
  // punctuation to discard — but a lone trailing period can also be
  // semantically part of the text itself, as a real abbreviation:
  // "Washington, D.C." lost its meaningful final period, silently reading
  // as a typo/truncation once spliced ("...traveled to Washington, D.C to
  // bring Maya home."). There's no fully reliable spelling-only way to
  // tell "a real abbreviation" from "a name someone ended with a
  // redundant period" (this app already declines to guess at the
  // analogous a/an vowel-sound ambiguity for the same reason) — a single
  // trailing period after a short (<=4 letter) trailing word ALONE isn't
  // reliable enough (an earlier version of this fix tried that and broke
  // a real existing test: "Mama Jo." is a plain short name, not an
  // abbreviation, and would have wrongly kept its period). The one signal
  // reliable enough to act on is an internal period within the trailing
  // token itself — an initialism shape like "D.C"/"p.m"/"a.m"/"U.S" that a
  // plain word never has — so only that narrower case is left alone; the
  // "Danny Jr."/"St. Louis, Mo." single-internal-word-abbreviation case is
  // a known, accepted gap (still stripped, same as before this fix) rather
  // than risk more name collisions. Found by a fresh-eyes review
  // 2026-07-28.
  //
  // The check above only recognized an abbreviation when the string's own
  // LITERAL last character was the abbreviation's period — so any other
  // trailing punctuation after it (a stray closing quote from a paste, a
  // trailing "!"/","/":") silently failed the check and fell through to
  // the generic strip, eating the abbreviation's own period right along
  // with the extra character ("Washington, D.C.\"" -> "Washington, D.C",
  // reopening the exact bug this whole function exists to prevent). Fixed
  // by detecting the abbreviation shape on the string with trailing
  // "wrapper" punctuation (not periods) peeled off first, and stripping
  // that same wrapper run — but not the abbreviation's real period — when
  // the abbreviation branch is taken. Found by a fresh-eyes review
  // 2026-07-28 (same day, same run as the fix above).
  //
  // The shape regex below anchors on `(?:^|\s)` immediately before the
  // abbreviation's first letter — but only TRAILING wrapper punctuation was
  // ever peeled off before that test, not leading. A value that IS the
  // abbreviation (or starts with it) with a leading wrapper character stuck
  // directly against it — a quote from a paste ('"D.C."'), or a dash from a
  // bulleted-list paste ("-D.C.") — has neither true string-start nor
  // whitespace right before "D", so the test wrongly returned false and the
  // abbreviation's real period was eaten by the generic branch instead
  // ('"D.C."' -> '"D.C"'). Fixed by peeling leading wrapper punctuation
  // before the shape test too, mirroring the trailing side. Found by a
  // fresh-eyes review 2026-07-28 (later the same day).
  //
  // The shape regex's own leading anchor was `(?:^|\s)` -- string-start or
  // a literal whitespace character right before the abbreviation's first
  // letter. That excludes an interior separator glued directly onto the
  // abbreviation with no space, e.g. "Washington,D.C." (a common way to
  // type it, just omitting the space after the comma) -- there's no
  // whitespace before "D", so the check wrongly returned false and the
  // real period was eaten by the generic branch: "Washington,D.C." ->
  // "Washington,D.C". Fixed by widening the anchor to "string-start, or any
  // non-letter character" instead of just whitespace -- this still rejects
  // a mid-word false match like "MAD.C." (the "D" there is preceded by the
  // letter "A", not a separator), which is the reason this anchor exists in
  // the first place. Found by a fresh-eyes review 2026-07-31.
  function looksLikeAbbreviation(str) {
    const core = str
      .replace(/[\s!?,;:…"'“”‘’\-–—]+$/, '')
      .replace(/^[\s!?,;:…"'“”‘’\-–—]+/, '');
    if (!/\.$/.test(core)) return false;
    if (/[\s.!?,;:…"'“”‘’\-–—]{2,}$/.test(core)) return false;
    return /(?:^|[^A-Za-z])[A-Za-z]\.[A-Za-z](?:\.[A-Za-z])*\.$/.test(core);
  }

  function stripTrailingPunctuation(str) {
    if (looksLikeAbbreviation(str)) {
      return str
        .replace(/[\s!?,;:…"'“”‘’\-–—]+$/, '')
        .replace(/^[\s.!?,;:…"'“”‘’\-–—]+/, '');
    }
    return str
      .replace(/[\s.!?,;:…"'“”‘’\-–—]+$/, '')
      .replace(/^[\s.!?,;:…"'“”‘’\-–—]+/, '');
  }

  // helperDetail/howCame are documented in prompts.js as short phrases meant
  // to be spliced mid-sentence ("a short phrase, starting with a verb"), with
  // lowercase placeholder examples — but a parent typing into an empty text
  // box naturally capitalizes the first letter, as if starting a new
  // sentence. Uncorrected, that produces a jarring mid-sentence capital in
  // the final PDF ("wanted Maya so much — A kind doctor..."), the same
  // "looks fine typed in, wrong once spliced into prose" failure mode this
  // app already guards against for trailing punctuation. `charAt`/`toLowerCase`
  // on a non-letter first character (a digit, an emoji) is a safe no-op.
  // Found by a fresh-eyes review 2026-07-24.
  function lowercaseFirst(str) {
    return str.charAt(0).toLowerCase() + str.slice(1);
  }

  function joinWithAnd(items) {
    const list = items.filter((s) => s && s.trim());
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    if (list.length === 2) return list[0] + ' and ' + list[1];
    return list.slice(0, -1).join(', ') + ', and ' + list[list.length - 1];
  }

  function getParentsList(a) {
    const raw = a.parentsLabel === 'Other' ? (a.parentsLabelCustom || '') : (a.parentsLabel || '');
    // Custom entries commonly join caregivers with "and", "&", a comma, a
    // semicolon, or a slash (e.g. "Grandma and Grandpa", "Grandma & Grandpa",
    // "Grandma, Grandpa", "Mama Rae; Mama Jo", "Mommy/Daddy"). Treat the
    // standalone word "and" as just another separator BEFORE splitting on
    // punctuation, rather than only recognizing it when it's whitespace-
    // bounded on both sides — otherwise "and" landing right next to a
    // punctuation separator (a redundant Oxford comma "Mom, Dad, and,
    // Grandma", a comma placed before instead of after it "Mom and, Dad",
    // "Mom; and Dad", or a doubled "Mom and and Dad") survives as its own
    // fake "parent" literally named "and", or stays glued to a real name.
    // \band\b won't fire inside a name like "Anderson" or "Sandy" — a word
    // boundary requires a transition to/from a non-word character.
    return raw
      .replace(/\band\b/gi, ',')
      .split(/[,&;/]+/)
      .map((s) => stripTrailingPunctuation(s.trim()))
      .filter(Boolean);
  }

  function getSiblingNames(a) {
    const n = clampSiblingCount(a.numSiblings || '0');
    const names = [];
    for (let i = 1; i <= n; i++) {
      const raw = a['siblingName' + i];
      if (!raw || !raw.trim()) continue;
      // A value made up entirely of punctuation (e.g. "...") is non-blank
      // text but strips down to nothing once stripTrailingPunctuation()
      // runs — without this filter an empty string still gets pushed,
      // producing a phantom "a " family member and stray commas/spaces on
      // several pages. Same failure shape already fixed for childName and
      // guarded against in getParentsList() via .filter(Boolean).
      const stripped = stripTrailingPunctuation(raw.trim());
      if (stripped) names.push(stripped);
    }
    return names;
  }

  function buildPages() {
    ensureAvatarDefaults();
    const a = state.answers;
    const st = STORY_TYPES.find((s) => s.id === state.storyType) || STORY_TYPES[0];
    // 'your child' (not 'you') so the placeholder reads correctly no matter
    // whether `name` lands as a subject ("your child was already loved by..."),
    // object ("...held your child"), or possessive ("...to be your child's
    // family, forever") — 'you' broke in the subject/possessive cases
    // ("you was...", "you's family"), visible in the live preview to every
    // new user before they've typed a name (childName is required, so this
    // never reaches an actual downloaded PDF).
    // Strip first, THEN check for blankness — a value that's entirely
    // punctuation (e.g. "...") is non-blank before stripping but empty
    // after, and checking the pre-strip value alone let it slip through
    // as a literal blank name in the rendered book (see the matching
    // allRequiredFilled() guard above, which normally blocks this at
    // input time; this is the defense-in-depth fallback for corrupted
    // saved state that bypasses that check).
    const name = (a.childName && stripTrailingPunctuation(a.childName.trim())) || 'your child';
    // Same strip-then-check shape as `name` just above — bookTitle is not a
    // required field (allRequiredFilled() never blocks it), so a
    // punctuation-only value (e.g. "...") reached the real downloaded PDF
    // unguarded: it became both the cover-page title text and the embedded
    // PDF document title (doc.setProperties()). Found by a fresh-eyes
    // review 2026-07-27.
    const title = (a.bookTitle && stripTrailingPunctuation(a.bookTitle.trim())) || st.defaultTitle;
    const season = a.season || 'spring';
    const parents = getParentsList(a);
    const siblings = getSiblingNames(a);
    const pet = a.petName && a.petName.trim() ? stripTrailingPunctuation(a.petName.trim()) : '';
    const parentsPhrase = joinWithAnd(parents) || 'a family';

    // withIndefiniteArticle() was applied to `parents` only, on the theory
    // that a parent entry is always a role word ("a Mommy", "a Grandma" —
    // fairy-tale-style generic titles), unlike a sibling's real proper name
    // ("a Danny" reads as nonsense — fixed earlier the same day this
    // comment was written). But `parents` isn't guaranteed to be a role
    // word at all: `getParentsList()` reads straight from
    // `parentsLabelCustom` free text when parentsLabel is "Other" — nothing
    // stops a parent from typing actual first names there ("Susan and
    // David"), reproducing the identical "a" + proper-name defect the
    // sibling fix just eliminated. And every OTHER page that mentions
    // parents (buildOriginSentence, the journey/held/headed-home pages,
    // family-portrait, just below) already uses the bare `parentsPhrase` —
    // no article, even for the built-in role-word presets like "Mommy and
    // Daddy" — so this page was the ONLY place an article was ever added
    // for parents, not just for siblings. Removing it here instead makes
    // every family member (parents, siblings, pet) consistent with how the
    // rest of the book already refers to them, and closes the custom-label
    // gap without needing to distinguish "role word" from "proper name" —
    // a distinction the app has no reliable way to make from text alone.
    // Found by a fresh-eyes review 2026-07-27, following up the
    // just-shipped sibling fix the same day.
    const members = [...parents, ...siblings, ...(pet ? ['a pet named ' + pet] : [])];

    // Kinship adoption's own origin sentence (buildOriginSentence) is built on
    // an "already loved [name]" premise — a pre-existing relationship, not a
    // first meeting. Blended family's premise is two already-existing families
    // merging as the child grows, not a newborn/first-arrival scene. Foster
    // care is deliberately non-committal about timing since the child may
    // have already lived with the family for months or years. Computed here
    // (before the baby-portrait page below, which needs it too) since the
    // held/journey/headed-home pages further down also need it.
    const isKinshipAdoption = state.storyType === 'adoption' && a.adoptionPath === 'Kinship / relative adoption';
    const isBlended = state.storyType === 'blended';
    const isFosterCare = state.storyType === 'adoption' && a.adoptionPath === 'Foster care';

    // Every page gets a stable `pageId`, distinct from `kind` — a semantic
    // slot name (e.g. 'journey', 'joyfulDetail') that identifies WHICH page
    // this is regardless of whether it's conditionally present, unlike kind
    // (shared by several different 'text' pages) or content (which changes
    // as answers change, and disappears entirely if the page is removed).
    // renderPreview() uses this to re-anchor the viewer's position when a
    // conditional page they were viewing gets removed by an edit elsewhere.
    const pages = [];
    pages.push({
      pageId: 'title',
      kind: 'title',
      title: title,
      subtitle: 'A story for ' + name,
      motif: 'rainbow',
      photo: isValidPhotoDataUrl(a.childPhoto) ? a.childPhoto : null,
      useAvatar: !isValidPhotoDataUrl(a.childPhoto),
    });

    // "[name], ready for the world" reads as a newborn/first-arrival scene —
    // the same "unconditional page contradicts a path's own premise" class
    // already fixed for the held/journey/headed-home pages below, just on
    // the one page with an actual baby illustration. Found by a fresh-eyes
    // review 2026-07-26.
    pages.push({
      pageId: 'baby-portrait',
      kind: 'baby-portrait',
      label: (isKinshipAdoption || isBlended || isFosterCare) ? ('Meet ' + name + '!') : 'Here I was!',
      text: (isKinshipAdoption || isBlended || isFosterCare) ? 'The heart of this story.' : (name + ', ready for the world.'),
      motif: 'sparkle',
    });

    pages.push({
      pageId: 'opening',
      kind: 'text',
      label: 'Once upon a time…',
      // "there was"/"there were" must agree with how many members end up
      // joined — the default parents label alone is 2 entries ("Mommy and
      // Daddy"), so this is reachable via the single most common
      // configuration, not an edge case: "there was a Mommy and a Daddy"
      // is a subject-verb mismatch. Found by a fresh-eyes review 2026-07-23.
      text:
        'Once upon a ' +
        season +
        '-time, there ' +
        (members.length <= 1 ? 'was' : 'were') +
        ' ' +
        (joinWithAnd(members) || 'a family') +
        '.',
      motif: 'moon-stars',
    });

    pages.push({ pageId: 'missing', kind: 'text', text: 'They loved their family, but something was missing!', motif: 'heart-outline' });

    pages.push({ pageId: 'idea', kind: 'text', label: 'Then, they had a great idea…', text: st.ideaLabel + '!', motif: 'lightbulb' });

    pages.push({ pageId: 'joined', kind: 'text', label: 'How ' + name + ' joined our family', text: buildOriginSentence(state.storyType, a, name, parentsPhrase), motif: 'house-heart' });

    // joyfulDetail/signOff are optional and shown verbatim (see the comment
    // above stripTrailingPunctuation — they intentionally keep whatever
    // punctuation the parent wrote, unlike spliced fields), so neither one
    // is ever checked by allRequiredFilled(). Without re-checking the
    // STRIPPED value here too, a punctuation-only value (e.g. "...") passed
    // the plain .trim() truthiness check and shipped a whole page whose
    // entire content was "...", with no warning, in both the live preview
    // and the real downloaded PDF. Found by a fresh-eyes review 2026-07-24.
    if (a.joyfulDetail && stripTrailingPunctuation(a.joyfulDetail.trim())) {
      pages.push({ pageId: 'joyfulDetail', kind: 'text', label: 'A joyful detail', text: a.joyfulDetail.trim(), motif: 'sparkle' });
    }

    // isKinshipAdoption/isBlended/isFosterCare are computed earlier now (see
    // the baby-portrait page above), since that page needed them too — the
    // "held for the first time" contradiction described below applies
    // equally to it.
    //
    // Kinship adoption's own origin sentence (buildOriginSentence) is built on
    // an "already loved [name]" premise — a pre-existing relationship, not a
    // first meeting — so "the very first time they held [name]" directly
    // contradicted it on every single Kinship-adoption book, with no optional
    // fields required to trigger it (unlike the travel-page instance of this
    // same contradiction class, fixed below for Kinship/International/Foster
    // care). Blended family has the same problem for a different reason: its
    // own premise (buildOriginSentence's blended branch, and the "met, fell
    // in love, and became one family" framing prompts.js invites) is two
    // already-existing families merging as the child grows, not a newborn/
    // first-meeting scene — "the very first time they held [name]" reads as
    // an infancy moment that doesn't fit, on every single blended-family
    // book. Foster care is the third case: its own origin sentence ("opened
    // their hearts and their home") is deliberately non-committal about
    // timing because a foster-to-adopt family may have already had the child
    // living with them — often for months or years — well before this "held
    // for the first time" page, which many real foster-adoptive families
    // would read as simply untrue.

    // travelPlace/travelDuration only exist in the adoption & surrogacy forms.
    // Switching story types doesn't clear state.answers (so shared fields like
    // childName carry over), so a stale value from a previously-selected type
    // must not leak into a type whose form can't even show/clear it.
    const hasTravelField = getFieldsFor(state.storyType).some((f) => f.id === 'travelPlace');
    // Compute the STRIPPED values up front and gate on those, not the
    // pre-strip .trim() truthiness — a punctuation-only value (e.g. "...")
    // is non-blank pre-strip but reduces to "" after
    // stripTrailingPunctuation(), which used to still get spliced in as-is
    // ("traveled to  to meet Alex.", dangling "to"/double space). Same
    // failure shape already fixed for childName/siblingName/helperDetail/
    // howCame; found by a fresh-eyes review 2026-07-23.
    const place = a.travelPlace ? stripTrailingPunctuation(a.travelPlace.trim()) : '';
    const duration = a.travelDuration ? stripTrailingPunctuation(a.travelDuration.trim()) : '';
    if (hasTravelField && (place || duration)) {
      let text = parentsPhrase + ' traveled';
      if (place) text += ' to ' + place;
      if (duration) text += ' — ' + duration + ' of waiting and love';
      // Kinship AND International adoption's own origin sentences are both
      // built on an "already brought/home" premise (see buildOriginSentence),
      // not "met for the first time" — so "to meet [name]" here would
      // directly contradict the page right before it for either path. Foster
      // care needs its own third phrase, not either of the other two: unlike
      // Kinship/International, a foster-care trip isn't necessarily "bringing
      // [name] home" for the first time either (it could be a drive to a
      // finalization hearing long after the child already moved in) — so it
      // gets the same neutral, timing-agnostic treatment as its "held" page
      // below, true whether this was a first meeting or not. This used to
      // only check Kinship, then Kinship+International, even though
      // travelPlace/travelDuration are unconditional fields on the whole
      // adoption form (no showIf in prompts.js) reachable from every path,
      // including Foster care — a real, reachable bug found by a fresh-eyes
      // review 2026-07-22.
      let closing;
      if (isFosterCare) closing = ' to be with ' + name + '.';
      else if (state.storyType === 'adoption' &&
        (a.adoptionPath === 'Kinship / relative adoption' || a.adoptionPath === 'International adoption'))
        closing = ' to bring ' + name + ' home.';
      else closing = ' to meet ' + name + '.';
      text += closing;
      pages.push({ pageId: 'journey', kind: 'text', label: 'The journey', text: text, motif: 'plane' });
    }

    let heldText;
    if (isKinshipAdoption) {
      heldText = parentsPhrase + ' could hardly believe how blessed they were to finally make it official and call ' + name + ' their own.';
    } else if (isBlended) {
      heldText = parentsPhrase + ' could hardly believe how blessed they were the day they all finally became one family.';
    } else if (isFosterCare) {
      heldText = parentsPhrase + ' could hardly believe how blessed they were the day they knew ' + name + ' would always be their own.';
    } else {
      heldText = parentsPhrase + ' could hardly believe how blessed they were the very first time they held ' + name + '.';
    }
    pages.push({
      pageId: 'held',
      kind: 'text',
      text: heldText,
      motif: 'heart',
    });

    if (siblings.length) {
      // "So happy the wait was over" was re-flagged by a fresh-eyes review
      // 2026-07-25 as another instance of the "unconditional page
      // contradicts a path's own premise" class (Kinship/Blended/Foster
      // care) — but this EXACT line has already been explicitly
      // adjudicated defensible for every path on 2026-07-21, and
      // re-confirmed (not re-litigated, since no new evidence was offered)
      // on 2026-07-23 and 2026-07-24: "the wait" reads as the legal/
      // finalization process ending, not a first-physical-meeting claim,
      // so it holds even for a child who already lived with these
      // siblings. Left unchanged again — see docs/roadmap.md for the full
      // history if this gets re-flagged a 5th time.
      pages.push({
        pageId: 'sibling-hug',
        kind: 'text',
        text: joinWithAnd(siblings) + ' could not stop hugging and kissing ' + name + ', so happy the wait was over!',
        motif: 'two-hearts',
      });
    }

    // "Headed home" reads as a first-time homecoming — true for International
    // adoption (the journey page above already established a real trip home)
    // and the default paths, but contradicts Kinship (often already living
    // together) and Foster care (may have been living together for months or
    // years) the same way the neighboring "held"/"journey" pages already
    // guard against for those two paths. Found by a fresh-eyes review
    // 2026-07-23, the 7th instance of this same contradiction class. Blended
    // family is an 8th: it wasn't included in this if/else even though the
    // neighboring "held" page just above already special-cases it (two
    // already-existing families gradually merging, not a homecoming trip —
    // "the whole family" as a separate audience to tell doesn't even make
    // sense here, since the merging families already ARE the whole family).
    // Found by a fresh-eyes review 2026-07-23.
    let headedHomeText;
    if (isKinshipAdoption) {
      headedHomeText = 'And from that day on, it was official — ' + name + ' had always been family, and now everyone knew it for certain.';
    } else if (isBlended) {
      headedHomeText = 'And from that day on, they were simply one family — together for good.';
    } else if (isFosterCare) {
      headedHomeText = 'And from that day forward, they just kept right on being family — official now, and forever.';
    } else {
      headedHomeText = 'Then, everyone headed home, eager to share their happy news with the whole family!';
    }
    pages.push({ pageId: 'headed-home', kind: 'text', text: headedHomeText, motif: 'house' });

    pages.push({
      pageId: 'family-portrait',
      kind: 'family-portrait',
      label: 'Our family',
      text: parentsPhrase + (siblings.length ? ', ' + joinWithAnd(siblings) : '') + ' — together with ' + name + ', always.',
      motif: 'heart',
    });

    // Same punctuation-only guard as joyfulDetail/signOff above — promise
    // IS required, so allRequiredFilled() already blocks a punctuation-only
    // value from reaching an actual download, but this page-inclusion check
    // never got the matching guard, so the live preview (seen immediately,
    // before Download is even attempted) still rendered a broken "Our
    // promise to you" / "..." page. Found by a fresh-eyes review 2026-07-27.
    if (a.promise && stripTrailingPunctuation(a.promise.trim())) {
      pages.push({ pageId: 'promise', kind: 'text', label: 'Our promise to you', text: a.promise.trim(), motif: 'heart' });
    }

    // Same punctuation-only guard as joyfulDetail above.
    if (a.signOff && stripTrailingPunctuation(a.signOff.trim())) {
      pages.push({ pageId: 'signOff', kind: 'closing', text: a.signOff.trim(), motif: 'sparkle' });
    }

    pages.push({
      pageId: 'final',
      kind: 'closing',
      text: 'Everyone has a story. This is yours — and it’s only the beginning.',
      motif: 'rainbow',
    });

    return pages;
  }

  function buildOriginSentence(storyTypeId, a, name, parentsPhrase) {
    if (storyTypeId === 'surrogacy') {
      const helper = a.helperTerm || 'surrogate';
      // Was "A [helper] carried [name]..." — with helperTerm set to its
      // own "gestational carrier" option, that produced the awkward,
      // typo-reading word collision "A gestational carrier carried
      // Maya...". Reworded the verb so it reads cleanly for all three
      // helperTerm options. Found by a fresh-eyes review 2026-07-26.
      return 'A ' + helper + ' cared for ' + name + ' and kept ' + name + ' safe until it was time to meet ' + parentsPhrase + '.';
    }
    if (storyTypeId === 'ivf') {
      // A value made up entirely of punctuation (e.g. "...") is non-blank
      // pre-strip but reduces to "" after stripTrailingPunctuation() — the
      // old ternary only checked the pre-strip value, so it used the empty
      // string as-is instead of falling back to the default, producing
      // "...wanted Maya so much — , and then...". Same failure shape
      // already fixed for childName/siblingName; the `||` re-checks the
      // actual value that gets used.
      const detail = lowercaseFirst((a.helperDetail && stripTrailingPunctuation(a.helperDetail.trim())) || 'a little help from science');
      // Donor conception is a true, distinct part of some families' stories —
      // named plainly here rather than folded silently into this detail
      // (see docs/family-language-review.md).
      if (a.donorInvolved === 'Yes — an egg or sperm donor') {
        // Was "...with a generous donor's help" — collided with the
        // default `detail` fallback text itself ("a little help from
        // science"), producing "...a little help from science, with a
        // generous donor's help..." on every book that left helperDetail
        // blank and picked this donor option — the same word-repetition
        // shape as the surrogacy "gestational carrier carried" fix above.
        // Found by real-PDF visual inspection 2026-07-26.
        return parentsPhrase + ' wanted ' + name + ' so much — ' + detail + ', with support from a generous donor, and then, there ' + name + ' was!';
      }
      if (a.donorInvolved === 'Yes — a donor embryo') {
        return parentsPhrase + ' wanted ' + name + ' so much — ' + detail + ', and a donor’s generous gift of an embryo, and then, there ' + name + ' was!';
      }
      return parentsPhrase + ' wanted ' + name + ' so much — ' + detail + ', and then, there ' + name + ' was!';
    }
    if (storyTypeId === 'blended') {
      // Same fallback fix as helperDetail above.
      const how = lowercaseFirst((a.howCame && stripTrailingPunctuation(a.howCame.trim())) || 'met, fell in love, and became one family');
      return parentsPhrase + ' ' + how + ', and that is how our family grew.';
    }
    // adoption — the story differs by real path (see docs/adoption-language-review.md):
    // a single "birth mom chose you" narrative doesn't fit foster, international,
    // or kinship adoptions, so it only applies to that specific path.
    const path = a.adoptionPath || 'A birth parent chose us';
    if (path === 'Foster care') {
      return parentsPhrase + ' opened their hearts and their home, and that is how ' + name + ' became part of the family, forever.';
    }
    if (path === 'International adoption') {
      return parentsPhrase + ' traveled all the way to bring ' + name + ' home, and that is how our family grew, forever.';
    }
    if (path === 'Kinship / relative adoption') {
      return name + ' was already loved by ' + parentsPhrase + ' — and that is how ' + name + "'s family grew even bigger, forever.";
    }
    const term = a.birthParentTerm || 'birth mom';
    return 'The ' + term + ' loved ' + name + ' so much that they chose ' + parentsPhrase + ' to be ' + name + "'s family, forever.";
  }

  function renderPreview() {
    // previewIndex is a raw array position, but buildPages() can insert/remove
    // pages earlier in the sequence as answers change (e.g. filling in a
    // travel place inserts a "journey" page before the closing pages), or
    // rewrite a still-present page's own text (e.g. numSiblings changing
    // "Our family"'s member list) — if we kept showing the same numeric
    // index, the reader would silently see a *different* page's content
    // swapped in mid-edit, with no navigation action of their own. Every
    // page carries a stable `pageId` (buildPages(), above) precisely so this
    // re-anchor doesn't depend on content that can itself change or vanish.
    const previousPages = state._lastRenderedPages || [];
    const previousPage = previousPages[state.previewIndex];
    const pages = buildPages();
    if (previousPage) {
      let matchIndex = pages.findIndex((p) => p.pageId === previousPage.pageId);
      // The previously-viewed page can be removed outright (e.g. clearing
      // travelPlace/travelDuration while looking at "The journey" page) —
      // no pageId match exists at all. Walk backward through the OLD page
      // list for the nearest still-existing page and anchor there, so the
      // reader lands as close as possible to where they were instead of
      // wherever a later page happened to shift into their old numeric
      // slot (silently showing unrelated content with no navigation action
      // taken). Found by a fresh-eyes review 2026-07-25.
      if (matchIndex === -1) {
        for (let i = state.previewIndex - 1; i >= 0; i--) {
          const candidateId = previousPages[i] && previousPages[i].pageId;
          const idx = candidateId ? pages.findIndex((p) => p.pageId === candidateId) : -1;
          if (idx !== -1) { matchIndex = idx; break; }
        }
      }
      if (matchIndex !== -1) state.previewIndex = matchIndex;
    }
    state._lastRenderedPages = pages;
    if (state.previewIndex >= pages.length) state.previewIndex = pages.length - 1;
    if (state.previewIndex < 0) state.previewIndex = 0;
    const page = pages[state.previewIndex];

    els.preview.innerHTML = '';
    if (page.kind === 'title') {
      const photoSrc = page.photo || (page.useAvatar ? avatarSceneFor('face', 300) : null);
      if (photoSrc) {
        const img = document.createElement('img');
        img.className = 'preview-photo';
        img.alt = '';
        img.src = photoSrc;
        els.preview.appendChild(img);
      }
      const t = document.createElement('div');
      t.className = 'page-title';
      t.textContent = isolateRtlForDisplay(page.title);
      const s = document.createElement('div');
      s.className = 'page-text';
      s.style.marginTop = '0.8rem';
      s.style.fontSize = '1.05rem';
      s.textContent = isolateRtlForDisplay(page.subtitle);
      els.preview.appendChild(t);
      els.preview.appendChild(s);
    } else if (page.kind === 'baby-portrait' || page.kind === 'family-portrait') {
      if (page.label) {
        const l = document.createElement('div');
        l.className = 'page-label-inline';
        if (hasRtlScript(page.label)) l.style.fontStyle = 'normal';
        l.textContent = isolateRtlForDisplay(page.label);
        els.preview.appendChild(l);
      }
      const img = document.createElement('img');
      img.className = 'preview-scene';
      img.alt = '';
      img.src = avatarSceneFor(page.kind === 'baby-portrait' ? 'baby' : 'family', 500);
      els.preview.appendChild(img);
      const s = document.createElement('div');
      s.className = 'page-text';
      s.style.fontSize = '1rem';
      s.textContent = isolateRtlForDisplay(page.text);
      els.preview.appendChild(s);
    } else {
      if (page.label) {
        const l = document.createElement('div');
        l.className = 'page-label-inline';
        if (hasRtlScript(page.label)) l.style.fontStyle = 'normal';
        l.textContent = isolateRtlForDisplay(page.label);
        els.preview.appendChild(l);
      }
      const s = document.createElement('div');
      s.className = 'page-text';
      s.textContent = isolateRtlForDisplay(page.text);
      els.preview.appendChild(s);
    }

    // #page-label is role="status" aria-live="polite" — assigning
    // .textContent unconditionally always replaces the underlying text
    // node (even when the new string is byte-identical to the old one),
    // which is exactly the DOM mutation assistive tech watches for on a
    // live region. renderPreview() runs on every keystroke in every field
    // (via onFieldChange()), not just on Prev/Next navigation, so typing
    // anywhere re-announced "Page X of Y" after every character with no
    // page actually turning. This is the same chatter failure mode
    // #page-announcer was deliberately designed around from the start (see
    // movePreview()'s own comment) — just never applied here. Found by a
    // fresh-eyes review 2026-07-28.
    const nextPageLabelText = 'Page ' + (state.previewIndex + 1) + ' of ' + pages.length +
      (page.label ? ' — ' + isolateRtlForDisplay(page.label) : '');
    if (nextPageLabelText !== els.pageLabel.textContent) {
      els.pageLabel.textContent = nextPageLabelText;
    }
    els.prevBtn.disabled = state.previewIndex === 0;
    els.nextBtn.disabled = state.previewIndex === pages.length - 1;

    // isGeneratingPdf: a Prev/Next click mid-generation must not re-enable
    // the button out from under the still-visible "Generating…" label —
    // see the reentrancy guard in downloadBook() for the full story.
    els.downloadBtn.disabled = isGeneratingPdf || !state.storyType || !allRequiredFilled() || pendingPhotoUploads > 0;
    updateDownloadHint();

    const badChars = collectUnsupportedGlyphs(pages);
    if (badChars.length) {
      els.charsetWarning.hidden = false;
      // Each flagged character can itself be an RTL script (e.g. Arabic,
      // Hebrew) mixed into this LTR sentence, with LTR quote marks/commas on
      // either side — the same bidi-reordering problem already fixed for
      // .page-label-inline, just missed for this banner: without isolate
      // marks the quoted list visually reorders into an unreadable jumble.
      //
      // #charset-warning is role="status" aria-live="polite", and this runs
      // on every keystroke in every field via renderPreview() — a direct
      // .textContent assignment always replaces the text node even when the
      // string is byte-identical to what's already there, re-announcing the
      // whole warning after every subsequent keystroke anywhere in the form
      // for the rest of the session. #page-label/#download-hint got the same
      // fix (setLiveText()) earlier the same day this banner was missed.
      // Found by a fresh-eyes review 2026-07-28 (later the same day).
      setLiveText(els.charsetWarning, 'Heads up: the downloadable PDF can only display Latin/European ' +
        'letters right now, so ' + badChars.map((c) => '"' + isolateRtlForDisplay(c) + '"').join(', ') +
        ' will come out as garbled symbols in your download, even though it looks right here in the preview. ' +
        "We're sorry about that — wider language support is on our list.");
    } else {
      els.charsetWarning.hidden = true;
      setLiveText(els.charsetWarning, '');
    }
  }

  // The PDF's built-in font (jsPDF standard Helvetica/Times, WinAnsi-encoded)
  // only covers Latin + Latin-1 Supplement, unlike the browser's font in the
  // live preview above — so anything outside that (CJK, Arabic, Hebrew,
  // Cyrillic, emoji, ...) silently renders as mojibake in the PDF only.
  // This scans typed answers so we can warn honestly instead of shipping a
  // keepsake with a garbled child's name.
  // Windows-1252 (what jsPDF's standard fonts actually encode to) maps a
  // couple dozen extra characters above 0xFF into its 0x80-0x9F block — things
  // like em/en dashes and curly quotes that this product's own prompt copy
  // (see js/prompts.js's "promise" default) already relies on. Only codepoints
  // outside Latin-1 AND outside this extra set are genuinely unsupported.
  const WINANSI_EXTRA = new Set([
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
    0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
    0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
  ]);

  // Invisible-when-rendered codepoints (zero-width joiners, variation
  // selectors, bidi/directional marks, line/paragraph separators, skin-tone
  // modifiers, etc.) show up as their own iterator "character" in things like
  // a ZWJ family emoji, a skin-tone modified emoji, or a pasted U+2028 line
  // separator — quoting one in the warning renders as a meaningless bare ""
  // or an orphaned swatch glyph, since there's nothing visible to show the
  // parent. They're just as unsupported as any other non-Latin-1 glyph, so
  // still worth warning about, but not worth quoting individually. Covers the
  // whole Unicode "format" (Cf) and line/paragraph-separator (Zl/Zp)
  // categories rather than an explicit codepoint list, since the exact set of
  // invisible characters a parent could paste in is open-ended.
  const isInvisibleFormatting = (ch) => /^[\p{Cf}\p{Zl}\p{Zp}]$/u.test(ch);
  const isSkinToneModifier = (code) => code >= 0x1f3fb && code <= 0x1f3ff;

  function collectUnsupportedGlyphs(pages) {
    const found = new Set();
    let hasInvisibleOnly = false;
    const texts = [];
    pages.forEach((page) => {
      texts.push(page.title, page.subtitle, page.label, page.text);
    });
    texts.forEach((value) => {
      if (typeof value !== 'string') return;
      for (const ch of value) {
        const code = ch.codePointAt(0);
        if (code <= 0xff || WINANSI_EXTRA.has(code)) continue;
        if (isInvisibleFormatting(ch) || isSkinToneModifier(code)) {
          hasInvisibleOnly = true;
          continue;
        }
        found.add(ch);
      }
    });
    const list = Array.from(found);
    // A sequence made up ENTIRELY of invisible/modifier codepoints (rare, but
    // possible with a lone skin-tone modifier typed with no base emoji) would
    // otherwise silently produce zero displayed characters despite genuinely
    // being unsupported — surface it as a plain word instead of an empty list.
    if (!list.length && hasInvisibleOnly) list.push('a special character');
    return list;
  }

  function allRequiredFilled() {
    return getVisibleFields().every((f) => {
      if (!f.required) return true;
      const value = state.answers[f.id];
      if (!value || !value.trim()) return false;
      // A custom parents label like "," or "&" alone is non-blank text but
      // parses to zero actual names — that would leave the family-portrait
      // scene silently drawing generic silhouettes with nothing to back them.
      if (f.id === 'parentsLabelCustom') return getParentsList(state.answers).length > 0;
      // Same failure shape for the child's own name: a value made up
      // entirely of punctuation (e.g. "...") is non-blank text but strips
      // down to nothing once stripTrailingPunctuation() runs on it in
      // buildPages() — that produced a downloadable PDF with the name
      // silently blank everywhere ("A story for ", "  was already loved
      // by..."). Found live 2026-07-23.
      if (f.id === 'childName') return !!stripTrailingPunctuation(value.trim());
      // Same failure shape for sibling names: punctuation-only text passes
      // the generic non-blank check above but strips to nothing.
      if (f.id.startsWith('siblingName')) return !!stripTrailingPunctuation(value.trim());
      // Same failure shape for IVF's/blended's short free-text phrase
      // fields — buildOriginSentence() now falls back to a sensible
      // default when the stripped value is empty (rather than splicing in
      // ""), but a punctuation-only value should still read as unfilled
      // here so the parent gets a clear signal instead of their input
      // being silently swapped for boilerplate.
      if (f.id === 'helperDetail' || f.id === 'howCame') return !!stripTrailingPunctuation(value.trim());
      // Same failure shape for the promise field — the book's single most
      // important line ("Every Origin Story ends the same way: an
      // unconditional promise"). It's rendered near-verbatim in buildPages()
      // (`a.promise.trim()`, its own standalone page, not spliced), so a
      // punctuation-only value like "..." isn't garbled — it's just printed
      // as literally "..." on the promise page with nothing to warn the
      // parent the required field is effectively empty. Found live 2026-07-23.
      if (f.id === 'promise') return !!stripTrailingPunctuation(value.trim());
      return true;
    });
  }

  // Both renderPreview() (on every keystroke) and downloadBook()'s finally
  // block used to set #download-hint to "Your book is ready." purely from
  // els.downloadBtn.disabled, with no regard for whether #download-error
  // (role="alert") was currently showing a failed-download message right
  // below it — so a parent whose PDF generation failed (e.g. the jsPDF CDN
  // blocked/offline) saw a role="status" region insist the book was ready
  // while the role="alert" region right next to it said it couldn't be
  // created, and every subsequent keystroke re-confirmed the false "ready"
  // hint without ever resolving the contradiction. Found by a fresh-eyes
  // review 2026-07-23. Centralizing the hint update here means both call
  // sites automatically respect the error banner's current state.
  // #download-hint is role="status" aria-live="polite", and this is called
  // from renderPreview() on every keystroke in every field, not just when
  // its own text should actually change — assigning .textContent
  // unconditionally always replaces the underlying text node (even when
  // the new string is identical to the old one), which is the DOM
  // mutation assistive tech watches for on a live region. setLiveText()
  // only reassigns when the value actually differs, so typing in an
  // unrelated field no longer re-announces "Your book is ready." after
  // every character. Same fix/reasoning as #page-label just above; found
  // by the same fresh-eyes review 2026-07-28.
  function setLiveText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function updateDownloadHint() {
    if (els.downloadError && !els.downloadError.hidden) {
      setLiveText(els.downloadHint, '');
      return;
    }
    // Without this, a Prev/Next click mid-generation (renderPreview() calls
    // this) would overwrite the "Generating…" hint with "ready"/"fill in the
    // required prompts" text right next to a button that still literally
    // reads "Generating your book…" — the same disagreeing-UI-regions class
    // already fixed for other banners.
    if (isGeneratingPdf) {
      setLiveText(els.downloadHint, 'Generating your book — this can take a few seconds for a longer story.');
      return;
    }
    if (pendingPhotoUploads > 0) {
      setLiveText(els.downloadHint, "Still processing your photo — just a moment.");
      return;
    }
    setLiveText(els.downloadHint, els.downloadBtn.disabled
      ? 'Fill in the required prompts above to unlock your download.'
      : 'Your book is ready.');
  }

  function movePreview(delta) {
    state.previewIndex += delta;
    renderPreview();
    // #page-label (set inside renderPreview()) only ever announces "Page X
    // of Y — label", never the page's actual prose that a sighted reader
    // sees update live in #book-preview. Read the just-rendered page back
    // from state._lastRenderedPages (renderPreview() already re-anchored
    // state.previewIndex to a valid entry) and announce its real content
    // here specifically, not inside renderPreview() itself — that function
    // also re-runs on every keystroke while editing a field, and announcing
    // the whole page on every character typed would be disruptive chatter,
    // not a fix. Found by a fresh-eyes review 2026-07-26.
    const announcedPage = state._lastRenderedPages && state._lastRenderedPages[state.previewIndex];
    if (announcedPage && els.pageAnnouncer) {
      // The title page has no label/text — it has title/subtitle instead
      // (see buildPages()'s 'title' entry and renderPreview()'s own
      // page.kind === 'title' branch).
      els.pageAnnouncer.textContent = announcedPage.kind === 'title'
        ? announcedPage.title + '. ' + announcedPage.subtitle
        : (announcedPage.label ? announcedPage.label + '. ' : '') + (announcedPage.text || '');
    }
    saveProgress();
  }

  // Shrinks font size until the wrapped text fits within maxHeight (or hits
  // minSize) — a safety net so an unusually long combination of answers
  // (e.g. several sibling names plus a pet) can't overflow off the page.
  // lineHeightFactor MUST match the lineHeightFactor the caller passes to
  // doc.text() for this same block — otherwise the fit check verifies a
  // different (and potentially shorter) block height than what jsPDF
  // actually renders, which defeats the point of the safety net.
  function fitTextBlock(doc, text, maxWidth, maxHeight, opts) {
    let fontSize = opts.startSize;
    const minSize = opts.minSize;
    const lineHeightFactor = opts.lineHeightFactor;
    let lines, lineHeight, blockHeight;
    while (true) {
      doc.setFontSize(fontSize);
      lines = doc.splitTextToSize(text, maxWidth);
      lineHeight = fontSize * lineHeightFactor;
      blockHeight = lines.length * lineHeight;
      if (blockHeight <= maxHeight || fontSize <= minSize) break;
      fontSize -= 1;
    }
    return { lines, fontSize, lineHeight, blockHeight };
  }

  // jsPDF is loaded from a CDN (book.html) — a blocked/offline network, an
  // aggressive ad/tracker blocker, or any other generation error must not
  // fail silently, since the button otherwise looks like it did nothing.
  function downloadBook(evt) {
    // A double-click (easy to do, especially on a trackpad) fired this handler
    // twice, producing two separate PDF downloads. UIEvent.detail on a native
    // click event is the browser's own multi-click counter (2 for the second
    // click of a double-click, 3 for a triple, etc.) — ignore anything past
    // the first click of a cluster without affecting genuinely separate
    // single clicks (e.g. a retry after fixing a download error).
    if (evt && evt.detail > 1) return;
    // The button disables itself the moment a photo upload starts (see
    // pendingPhotoUploads), but guard the handler too in case a fast click or
    // Enter keypress lands in the same tick the upload begins, before the
    // disabled state has painted.
    if (pendingPhotoUploads > 0) return;
    // Guard against reentrancy the same way startOver()/selectStoryType()
    // already do: the ~2-frame gap before buildAndSaveDoc() actually runs
    // (below) leaves a window where renderPreview() (from a Prev/Next click,
    // not a second Download click — already guarded via evt.detail above)
    // can flip els.downloadBtn back to enabled, since it didn't know
    // generation was in progress. Without this guard, that click re-enters
    // downloadBook(), producing two PDF downloads from one Download click
    // plus one Prev/Next click, and can leave the button permanently stuck
    // reading "Generating your book…" if the reentrant call's finally block
    // runs last. Found by a fresh-eyes review 2026-07-23.
    if (isGeneratingPdf) return;
    els.downloadError.hidden = true;
    // buildAndSaveDoc() draws every page synchronously and can block the main
    // thread for a noticeable stretch on a heavy book (several avatar scenes
    // at print resolution, a real uploaded photo, many pages) — measured
    // ~230ms even on a fast dev machine, likely much longer on an average
    // parent's device. With no feedback the button just looked frozen,
    // inviting exactly the double-click this same function already guards
    // against. Disable the button and swap its label first, then wait two
    // animation frames (the standard way to force a paint of that change)
    // before doing the blocking work, so the "Generating…" state is actually
    // visible for the duration of the freeze.
    els.downloadBtn.disabled = true;
    isGeneratingPdf = true;
    const originalLabel = els.downloadBtn.textContent;
    els.downloadBtn.textContent = 'Generating your book…';
    els.downloadHint.textContent = 'Generating your book — this can take a few seconds for a longer story.';
    const runGeneration = () => {
      try {
        // pendingPhotoUploads was 0 when downloadBook() started (checked
        // above), but a drag-and-drop photo upload isn't blocked by
        // isGeneratingPdf (only the Download button itself is disabled) and
        // cropPhotoToSquare() is async — it can start and still be in
        // flight by the time this callback runs, ~2 frames later. Building
        // now would silently bake the OLD photo/avatar into the PDF while
        // the live preview moves on to the new one, with no warning.
        // Bail and let the normal pendingPhotoUploads-aware disabled state
        // (set in the finally block below) prompt a clean retry once the
        // upload actually finishes. Found by a fresh-eyes review 2026-07-23.
        if (pendingPhotoUploads > 0) return;
        buildAndSaveDoc();
      } catch (e) {
        console.error('PDF generation failed:', e);
        els.downloadError.hidden = false;
        els.downloadError.textContent =
          "We couldn't create your PDF — please check your internet connection and try again.";
      } finally {
        isGeneratingPdf = false;
        els.downloadBtn.textContent = originalLabel;
        els.downloadBtn.disabled = !state.storyType || !allRequiredFilled() || pendingPhotoUploads > 0;
        updateDownloadHint();
      }
    };
    // requestAnimationFrame callbacks are suspended (not just throttled) in a
    // backgrounded tab in every major browser — if a parent clicks Download
    // and switches to another tab/app before the next frame paints (an
    // ordinary thing to do while "waiting"), the two queued rAF callbacks
    // below can simply never fire, leaving the button stuck reading
    // "Generating your book…" indefinitely with no error, until they happen
    // to return to this exact tab. Falling back to a visibilitychange
    // listener means generation still runs the moment the tab becomes
    // visible again, even if rAF is still suspended at that point. Found by
    // a fresh-eyes review 2026-07-24.
    let ran = false;
    const runOnce = () => {
      if (ran) return;
      ran = true;
      document.removeEventListener('visibilitychange', onVisible);
      runGeneration();
    };
    const onVisible = () => { if (!document.hidden) runOnce(); };
    document.addEventListener('visibilitychange', onVisible);
    requestAnimationFrame(() => {
      requestAnimationFrame(runOnce);
    });
  }

  function buildAndSaveDoc() {
    const pages = buildPages();
    const theme = themeFor(state.storyType);
    const st = STORY_TYPES.find((s) => s.id === state.storyType) || STORY_TYPES[0];
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    // Without this, PDF viewers and screen readers fall back to the raw
    // filename instead of the book's actual title.
    doc.setProperties({
      title: pages[0].title,
      subject: pages[0].subtitle,
      creator: 'Origin Stories: Identity Books',
      keywords: st.label,
    });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 72;
    const maxWidth = pageWidth - margin * 2;
    const iconY = 118;

    pages.forEach((page, i) => {
      if (i > 0) doc.addPage();

      drawPageFrame(doc, pageWidth, pageHeight, theme);
      const titleHasImage = page.kind === 'title' && (page.photo || page.useAvatar);
      if (!titleHasImage) {
        drawMotif(doc, page.motif || 'heart', pageWidth / 2, page.kind === 'title' ? pageHeight * 0.24 : iconY, 22, theme);
      }

      const bottomLimit = pageHeight - 60;

      if (page.kind === 'title') {
        let titleTop;
        if (titleHasImage) {
          const photoSize = 150;
          const photoX = pageWidth / 2 - photoSize / 2;
          const photoY = 68;
          const cx = photoX + photoSize / 2;
          const cy = photoY + photoSize / 2;
          const rad = photoSize / 2;
          // 625px for a 150pt circle = 300 DPI (print quality); the drawing
          // routine is resolution-independent so this costs nothing visually.
          const imgSrc = page.photo || avatarSceneFor('face', 625);
          const imgFormat = page.photo ? 'JPEG' : 'PNG';
          // restoreGraphicsState() MUST run even if addImage() throws (corrupt/
          // unsupported image data) — otherwise the circular clip set by
          // doc.clip() below stays in effect for the rest of this page's
          // content stream, silently cutting off the title/subtitle text
          // drawn further down. Found by a fresh-eyes review 2026-07-25.
          doc.saveGraphicsState();
          try {
            doc.circle(cx, cy, rad, null);
            doc.clip();
            doc.discardPath();
            doc.addImage(imgSrc, imgFormat, photoX, photoY, photoSize, photoSize, undefined, 'MEDIUM');
          } catch (e) {
            // Corrupt/unsupported image data — skip the photo, keep the rest of the page intact.
          } finally {
            doc.restoreGraphicsState();
          }
          doc.setDrawColor(theme.WARM[0], theme.WARM[1], theme.WARM[2]);
          doc.setLineWidth(2);
          doc.circle(cx, cy, rad, 'S');
          titleTop = photoY + photoSize + 34;
        } else {
          titleTop = pageHeight * 0.24 + 40;
        }
        doc.setFont('times', 'bold');
        const title = fitTextBlock(doc, page.title, maxWidth, bottomLimit - titleTop - 60, {
          startSize: 30,
          minSize: 16,
          lineHeightFactor: 1.3,
        });
        doc.setTextColor(51, 41, 31);
        const titleBaseline = titleTop + title.lineHeight;
        doc.text(title.lines, pageWidth / 2, titleBaseline, { align: 'center', lineHeightFactor: 1.3 });
        const titleBottom = titleBaseline + (title.lines.length - 1) * title.lineHeight;

        doc.setFont('times', 'italic');
        const subtitle = fitTextBlock(doc, page.subtitle, maxWidth, bottomLimit - titleBottom - 24, {
          startSize: 16,
          minSize: 11,
          lineHeightFactor: 1.3,
        });
        const subtitleBaseline = titleBottom + 24 + subtitle.lineHeight;
        doc.text(subtitle.lines, pageWidth / 2, subtitleBaseline, { align: 'center', lineHeightFactor: 1.3 });
      } else if (page.kind === 'baby-portrait' || page.kind === 'family-portrait') {
        let labelBottom = iconY + 40;
        if (page.label) {
          doc.setFont('times', 'bolditalic');
          doc.setTextColor(theme.WARM_DARK[0], theme.WARM_DARK[1], theme.WARM_DARK[2]);
          const label = fitTextBlock(doc, page.label, maxWidth, 60, {
            startSize: 13,
            minSize: 9,
            lineHeightFactor: 1.2,
          });
          const labelBaseline = iconY + 44;
          doc.text(label.lines, pageWidth / 2, labelBaseline, { align: 'center', lineHeightFactor: 1.2 });
          doc.setTextColor(51, 41, 31);
          labelBottom = labelBaseline + (label.lines.length - 1) * label.lineHeight + 16;
        }
        const imgSize = 250;
        const imgX = pageWidth / 2 - imgSize / 2;
        const imgY = labelBottom + 14;
        try {
          // 1042px for a 250pt image = 300 DPI (print quality), same reasoning as the face scene above.
          const sceneUrl = avatarSceneFor(page.kind === 'baby-portrait' ? 'baby' : 'family', 1042);
          doc.addImage(sceneUrl, 'PNG', imgX, imgY, imgSize, imgSize, undefined, 'MEDIUM');
        } catch (e) {
          // Canvas rendering unsupported — skip the illustration, keep the caption.
        }
        doc.setFont('times', 'normal');
        doc.setTextColor(51, 41, 31);
        const captionTop = imgY + imgSize + 22;
        const body = fitTextBlock(doc, page.text, maxWidth, bottomLimit - captionTop, {
          startSize: 15,
          minSize: 10,
          lineHeightFactor: 1.35,
        });
        doc.text(body.lines, pageWidth / 2, captionTop + body.lineHeight, {
          align: 'center',
          lineHeightFactor: 1.35,
        });
      } else {
        let labelBottom = iconY + 40;
        if (page.label) {
          doc.setFont('times', 'bolditalic');
          doc.setTextColor(theme.WARM_DARK[0], theme.WARM_DARK[1], theme.WARM_DARK[2]);
          const label = fitTextBlock(doc, page.label, maxWidth, 60, {
            startSize: 13,
            minSize: 9,
            lineHeightFactor: 1.2,
          });
          const labelBaseline = iconY + 44;
          doc.text(label.lines, pageWidth / 2, labelBaseline, { align: 'center', lineHeightFactor: 1.2 });
          doc.setTextColor(51, 41, 31);
          labelBottom = labelBaseline + (label.lines.length - 1) * label.lineHeight + 16;
        }
        doc.setFont('times', 'normal');
        const body = fitTextBlock(doc, page.text, maxWidth, bottomLimit - labelBottom, {
          startSize: 19,
          minSize: 10,
          lineHeightFactor: 1.4,
        });
        let startY = pageHeight / 2 - body.blockHeight / 2 + body.lineHeight;
        if (startY < labelBottom + body.lineHeight) startY = labelBottom + body.lineHeight;
        doc.text(body.lines, pageWidth / 2, startY, {
          align: 'center',
          lineHeightFactor: 1.4,
        });
      }
    });

    const name = (state.answers.childName || '').trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents (e.g. "Siobhán" -> "Siobhan") instead of turning them into stray hyphens
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    // A name written entirely in a non-Latin script (e.g. "小明") has nothing
    // left after the above, which used to save as the broken "--origin-story.pdf".
    doc.save((name ? name + '-' : '') + 'origin-story.pdf');
  }

  // --- decorative vector motifs (kept as simple shape primitives, no image assets) ---

  const INK = [51, 41, 31];

  // Per-story-type accent palettes. Kept in sync with the WARM/WARM-DARK/SOFT
  // custom properties in css/style.css so the live preview and the
  // downloaded PDF use matching colors. INK (body text) stays constant.
  const THEMES = {
    adoption: { WARM: [201, 113, 58], WARM_DARK: [168, 90, 42], SOFT: [238, 225, 207] },
    surrogacy: { WARM: [90, 140, 150], WARM_DARK: [58, 102, 112], SOFT: [204, 226, 228] },
    ivf: { WARM: [142, 110, 168], WARM_DARK: [104, 74, 130], SOFT: [223, 210, 232] },
    blended: { WARM: [124, 148, 96], WARM_DARK: [90, 112, 64], SOFT: [216, 226, 200] },
  };

  function themeFor(storyTypeId) {
    return THEMES[storyTypeId] || THEMES.adoption;
  }

  function drawPageFrame(doc, pageWidth, pageHeight, theme) {
    doc.setDrawColor(theme.WARM[0], theme.WARM[1], theme.WARM[2]);
    doc.setLineWidth(1.1);
    doc.roundedRect(28, 28, pageWidth - 56, pageHeight - 56, 10, 10, 'S');
    doc.setFillColor(theme.WARM_DARK[0], theme.WARM_DARK[1], theme.WARM_DARK[2]);
    [[28, 28], [pageWidth - 28, 28], [28, pageHeight - 28], [pageWidth - 28, pageHeight - 28]].forEach(([x, y]) => {
      doc.circle(x, y, 2.2, 'F');
    });
  }

  function heart(doc, cx, cy, r, color, style) {
    doc.setFillColor(color[0], color[1], color[2]);
    doc.setDrawColor(color[0], color[1], color[2]);
    const lobeR = r * 0.52;
    doc.circle(cx - lobeR * 0.6, cy - lobeR * 0.35, lobeR, style);
    doc.circle(cx + lobeR * 0.6, cy - lobeR * 0.35, lobeR, style);
    doc.triangle(cx - r, cy - lobeR * 0.15, cx + r, cy - lobeR * 0.15, cx, cy + r * 0.85, style);
  }

  function sparkle(doc, cx, cy, r, theme) {
    doc.setDrawColor(theme.WARM_DARK[0], theme.WARM_DARK[1], theme.WARM_DARK[2]);
    doc.setLineWidth(2);
    doc.line(cx, cy - r, cx, cy + r);
    doc.line(cx - r, cy, cx + r, cy);
    doc.setLineWidth(1.2);
    doc.line(cx - r * 0.5, cy - r * 0.5, cx + r * 0.5, cy + r * 0.5);
    doc.line(cx - r * 0.5, cy + r * 0.5, cx + r * 0.5, cy - r * 0.5);
  }

  function moonStars(doc, cx, cy, r, theme) {
    doc.setFillColor(theme.WARM_DARK[0], theme.WARM_DARK[1], theme.WARM_DARK[2]);
    doc.circle(cx, cy, r * 0.6, 'F');
    // "Erases" a bite out of the moon to leave a crescent — the page itself
    // is plain white (drawPageFrame fills no background), so this must match
    // white exactly, not theme.CREAM, or the cut shows as a visible tinted disc.
    doc.setFillColor(255, 255, 255);
    doc.circle(cx + r * 0.32, cy - r * 0.22, r * 0.5, 'F');
    sparkleDot(doc, cx - r * 1.1, cy - r * 0.5, 2.5, theme);
    sparkleDot(doc, cx + r * 1.25, cy + r * 0.3, 2, theme);
    sparkleDot(doc, cx - r * 0.6, cy + r * 0.7, 1.8, theme);
  }

  function sparkleDot(doc, cx, cy, r, theme) {
    doc.setDrawColor(theme.WARM[0], theme.WARM[1], theme.WARM[2]);
    doc.setLineWidth(1);
    doc.line(cx, cy - r, cx, cy + r);
    doc.line(cx - r, cy, cx + r, cy);
  }

  function lightbulb(doc, cx, cy, r, theme) {
    doc.setDrawColor(theme.WARM_DARK[0], theme.WARM_DARK[1], theme.WARM_DARK[2]);
    doc.setLineWidth(1.6);
    doc.circle(cx, cy - r * 0.15, r * 0.6, 'S');
    doc.rect(cx - r * 0.18, cy + r * 0.38, r * 0.36, r * 0.22, 'S');
    for (let i = 0; i < 5; i++) {
      const angle = Math.PI + (Math.PI / 4) * i;
      doc.line(cx + Math.cos(angle) * r * 0.65, cy - r * 0.15 + Math.sin(angle) * r * 0.65, cx + Math.cos(angle) * r * 0.95, cy - r * 0.15 + Math.sin(angle) * r * 0.95);
    }
  }

  function house(doc, cx, cy, r, color) {
    doc.setFillColor(color[0], color[1], color[2]);
    doc.triangle(cx - r, cy - r * 0.05, cx + r, cy - r * 0.05, cx, cy - r * 0.85, 'F');
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(1.6);
    doc.rect(cx - r * 0.68, cy - r * 0.05, r * 1.36, r * 0.85, 'S');
    doc.setFillColor(color[0], color[1], color[2]);
    doc.rect(cx - r * 0.15, cy + r * 0.25, r * 0.3, r * 0.55, 'F');
  }

  function plane(doc, cx, cy, r, theme) {
    doc.setFillColor(theme.WARM_DARK[0], theme.WARM_DARK[1], theme.WARM_DARK[2]);
    doc.triangle(cx - r, cy + r * 0.6, cx + r * 1.1, cy, cx - r * 0.15, cy - r * 0.15, 'F');
    doc.setFillColor(theme.WARM[0], theme.WARM[1], theme.WARM[2]);
    doc.triangle(cx - r * 0.15, cy - r * 0.15, cx + r * 1.1, cy, cx - r * 0.35, cy + r * 0.15, 'F');
  }

  function rainbow(doc, cx, cy, r, theme) {
    const bands = [theme.WARM_DARK, theme.WARM, theme.SOFT];
    bands.forEach((c, i) => {
      const rr = r - i * (r * 0.24);
      doc.setFillColor(c[0], c[1], c[2]);
      doc.ellipse(cx, cy, rr, rr * 0.72, 'F');
    });
    // Masks the bottom half of the arc so it reads as emerging from the
    // page — must match the page's actual (plain white) background, not
    // theme.CREAM, or the mask shows as a visible tinted box (see moonStars).
    doc.setFillColor(255, 255, 255);
    doc.rect(cx - r - 4, cy, (r + 4) * 2, r * 0.72 + 4, 'F');
  }

  function drawMotif(doc, motif, cx, cy, r, theme) {
    switch (motif) {
      case 'rainbow': return rainbow(doc, cx, cy, r, theme);
      case 'moon-stars': return moonStars(doc, cx, cy, r, theme);
      case 'heart-outline': return heart(doc, cx, cy, r, theme.WARM_DARK, 'S');
      case 'lightbulb': return lightbulb(doc, cx, cy, r, theme);
      case 'house-heart':
        house(doc, cx, cy, r, theme.WARM_DARK);
        heart(doc, cx, cy + r * 0.35, r * 0.32, theme.WARM, 'F');
        return;
      case 'sparkle': return sparkle(doc, cx, cy, r * 0.75, theme);
      case 'plane': return plane(doc, cx, cy, r * 0.85, theme);
      case 'two-hearts':
        heart(doc, cx - r * 0.4, cy + r * 0.1, r * 0.6, theme.WARM, 'F');
        heart(doc, cx + r * 0.4, cy - r * 0.05, r * 0.6, theme.WARM_DARK, 'F');
        return;
      case 'house': return house(doc, cx, cy, r, theme.WARM_DARK);
      case 'heart':
      default:
        return heart(doc, cx, cy, r, theme.WARM_DARK, 'F');
    }
  }

  // This script tag sits at the end of <body>, after every element init()
  // touches, so the DOM is already complete here — no need to wait for
  // DOMContentLoaded (which would also mean waiting on the jsPDF <script>
  // tag below this one, defeating the point of moving it last). Called at
  // the bottom of the file, not the top, so every const/function above
  // (THEMES, etc.) is already initialized before init() can reach them.
  init();
})();
