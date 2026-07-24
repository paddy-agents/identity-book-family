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
      const ownLastSaved = JSON.stringify({
        storyType: state.storyType,
        answers: state.answers,
        titleTouched: state.titleTouched,
        previewIndex: state.previewIndex,
      });
      checkForStorageConflict(ownLastSaved, localStorage.getItem(STORAGE_KEY));
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
    Object.keys(state.answers).forEach((k) => {
      if (typeof state.answers[k] === 'string') state.answers[k] = sanitizeFieldValue(k, state.answers[k]);
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
    if (!state.titleTouched || !state.answers.bookTitle) {
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
  }

  // Shared by the 'storage' listener (fires in other tabs on every write)
  // and the 'pageshow'/bfcache-restore listener (which has no live event to
  // read oldValue/newValue from, so it passes its own reconstructed
  // last-known-saved JSON instead). oldValue/newValue are both raw JSON
  // strings (or null), matching what a real StorageEvent provides.
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
    let onlyPreviewIndexChanged = false;
    try {
      const withoutPreviewIndex = (raw) => {
        if (!raw) return raw;
        const parsed = JSON.parse(raw);
        delete parsed.previewIndex;
        return JSON.stringify(parsed);
      };
      onlyPreviewIndexChanged = withoutPreviewIndex(oldValue) === withoutPreviewIndex(newValue);
    } catch (err) {
      // Malformed JSON on either side — fall through and warn, same as the
      // pre-existing behavior.
    }
    if (onlyPreviewIndexChanged) return;
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
    }
    state.storyType = id;
    state.previewIndex = 0;
    [...els.storyTypes.children].forEach((card) => {
      const isSelected = card.dataset.id === id;
      card.classList.toggle('selected', isSelected);
      card.setAttribute('aria-pressed', String(isSelected));
    });

    const st = STORY_TYPES.find((s) => s.id === id);
    if (!state.titleTouched || !state.answers.bookTitle) {
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
        for (let i = 1; i <= n; i++) out.push(siblingField(i));
        return;
      }
      if (f.showIf && !f.showIf(state.answers)) return;
      out.push(f);
    });
    return out;
  }

  function ensureAvatarDefaults() {
    if (!state.answers.childAvatar) {
      state.answers.childAvatar = Object.assign({}, AvatarKit.DEFAULT_AVATAR);
    }
  }

  function renderFields() {
    ensureAvatarDefaults();
    const fields = getVisibleFields();
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
      label.textContent = f.label + (f.required ? '' : ' (optional)');
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
      if (f.hint) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.id = 'field-' + f.id + '-hint';
        hint.textContent = f.hint;
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
    errorMsg.setAttribute('role', 'alert');
    errorMsg.hidden = true;
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
    return str.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').normalize('NFC');
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
    return () => {
      if (f.id === 'bookTitle') state.titleTouched = true;
      state.answers[f.id] = sanitizeFieldValue(f.id, input.value);
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

  function withIndefiniteArticle(word) {
    // Strip accents before testing so names like "Émile"/"Óscar" get "an",
    // not just plain-ASCII vowel starters.
    const plain = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return (/^[aeiou]/i.test(plain) ? 'an ' : 'a ') + word;
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
  // for. Only strips from the END of the string, so it's safe to apply even
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
  function stripTrailingPunctuation(str) {
    return str.replace(/\s*[.!?,;…]+$/, '');
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
    const title = a.bookTitle && a.bookTitle.trim() ? a.bookTitle.trim() : st.defaultTitle;
    const season = a.season || 'spring';
    const parents = getParentsList(a);
    const siblings = getSiblingNames(a);
    const pet = a.petName && a.petName.trim() ? stripTrailingPunctuation(a.petName.trim()) : '';
    const parentsPhrase = joinWithAnd(parents) || 'a family';

    const members = [
      ...parents.map(withIndefiniteArticle),
      ...siblings.map(withIndefiniteArticle),
      ...(pet ? ['a pet named ' + pet] : []),
    ];

    const pages = [];
    pages.push({
      kind: 'title',
      title: title,
      subtitle: 'A story for ' + name,
      motif: 'rainbow',
      photo: a.childPhoto || null,
      useAvatar: !a.childPhoto,
    });

    pages.push({
      kind: 'baby-portrait',
      label: 'Here I was!',
      text: name + ', ready for the world.',
      motif: 'sparkle',
    });

    pages.push({
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

    pages.push({ kind: 'text', text: 'They loved their family, but something was missing!', motif: 'heart-outline' });

    pages.push({ kind: 'text', label: 'Then, they had a great idea…', text: st.ideaLabel + '!', motif: 'lightbulb' });

    pages.push({ kind: 'text', label: 'How ' + name + ' joined our family', text: buildOriginSentence(state.storyType, a, name, parentsPhrase), motif: 'house-heart' });

    if (a.joyfulDetail && a.joyfulDetail.trim()) {
      pages.push({ kind: 'text', label: 'A joyful detail', text: a.joyfulDetail.trim(), motif: 'sparkle' });
    }

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
    // would read as simply untrue. Computed here (before the travel page
    // below) since all three paths need it there too.
    const isKinshipAdoption = state.storyType === 'adoption' && a.adoptionPath === 'Kinship / relative adoption';
    const isBlended = state.storyType === 'blended';
    const isFosterCare = state.storyType === 'adoption' && a.adoptionPath === 'Foster care';

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
      pages.push({ kind: 'text', label: 'The journey', text: text, motif: 'plane' });
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
      kind: 'text',
      text: heldText,
      motif: 'heart',
    });

    if (siblings.length) {
      pages.push({
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
    pages.push({ kind: 'text', text: headedHomeText, motif: 'house' });

    pages.push({
      kind: 'family-portrait',
      label: 'Our family',
      text: parentsPhrase + (siblings.length ? ', ' + joinWithAnd(siblings) : '') + ' — together with ' + name + ', always.',
      motif: 'heart',
    });

    if (a.promise && a.promise.trim()) {
      pages.push({ kind: 'text', label: 'Our promise to you', text: a.promise.trim(), motif: 'heart' });
    }

    if (a.signOff && a.signOff.trim()) {
      pages.push({ kind: 'closing', text: a.signOff.trim(), motif: 'sparkle' });
    }

    pages.push({
      kind: 'closing',
      text: 'Everyone has a story. This is yours — and it’s only the beginning.',
      motif: 'rainbow',
    });

    return pages;
  }

  function buildOriginSentence(storyTypeId, a, name, parentsPhrase) {
    if (storyTypeId === 'surrogacy') {
      const helper = a.helperTerm || 'surrogate';
      return 'A ' + helper + ' carried ' + name + ' and kept ' + name + ' safe until it was time to meet ' + parentsPhrase + '.';
    }
    if (storyTypeId === 'ivf') {
      // A value made up entirely of punctuation (e.g. "...") is non-blank
      // pre-strip but reduces to "" after stripTrailingPunctuation() — the
      // old ternary only checked the pre-strip value, so it used the empty
      // string as-is instead of falling back to the default, producing
      // "...wanted Maya so much — , and then...". Same failure shape
      // already fixed for childName/siblingName; the `||` re-checks the
      // actual value that gets used.
      const detail = (a.helperDetail && stripTrailingPunctuation(a.helperDetail.trim())) || 'a little help from science';
      // Donor conception is a true, distinct part of some families' stories —
      // named plainly here rather than folded silently into this detail
      // (see docs/family-language-review.md).
      if (a.donorInvolved === 'Yes — an egg or sperm donor') {
        return parentsPhrase + ' wanted ' + name + ' so much — ' + detail + ', with a generous donor’s help, and then, there ' + name + ' was!';
      }
      if (a.donorInvolved === 'Yes — a donor embryo') {
        return parentsPhrase + ' wanted ' + name + ' so much — ' + detail + ', and a donor’s generous gift of an embryo, and then, there ' + name + ' was!';
      }
      return parentsPhrase + ' wanted ' + name + ' so much — ' + detail + ', and then, there ' + name + ' was!';
    }
    if (storyTypeId === 'blended') {
      // Same fallback fix as helperDetail above.
      const how = (a.howCame && stripTrailingPunctuation(a.howCame.trim())) || 'met, fell in love, and became one family';
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
    // travel place inserts a "journey" page before the closing pages) — if we
    // kept showing the same numeric index, the reader would silently see a
    // *different* page's content swapped in mid-edit, with no navigation
    // action of their own. Re-anchor to the same page by content identity
    // when it still exists; only fall back to raw clamping when it's gone
    // (e.g. the page they were viewing was itself just removed).
    const previousPage = (state._lastRenderedPages || [])[state.previewIndex];
    const pages = buildPages();
    if (previousPage) {
      let matchIndex = pages.findIndex(
        (p) => p.kind === previousPage.kind && p.label === previousPage.label && p.text === previousPage.text
      );
      // numSiblings is the one field whose change can simultaneously shift
      // page positions (removing/adding the sibling-hug page) AND rewrite
      // the TEXT of a different, still-present page that mentions sibling
      // names/count (e.g. "Our family" on the family-portrait page) — so
      // the exact content match above fails even though the reader is still
      // looking at conceptually the same page, and the raw numeric index
      // (now pointing at whatever shifted into that slot) isn't out of
      // bounds either, so it silently shows the wrong page. Found by a
      // fresh-eyes review 2026-07-23. Fall back to matching by `kind` alone
      // for the three kinds guaranteed to appear at most once per book
      // (title/baby-portrait/family-portrait) — safe because there's never
      // more than one to be ambiguous between, unlike 'text'/'closing'.
      if (matchIndex === -1 && ['title', 'baby-portrait', 'family-portrait'].includes(previousPage.kind)) {
        matchIndex = pages.findIndex((p) => p.kind === previousPage.kind);
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

    els.pageLabel.textContent = 'Page ' + (state.previewIndex + 1) + ' of ' + pages.length +
      (page.label ? ' — ' + isolateRtlForDisplay(page.label) : '');
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
      els.charsetWarning.textContent = 'Heads up: the downloadable PDF can only display Latin/European ' +
        'letters right now, so ' + badChars.map((c) => '"' + isolateRtlForDisplay(c) + '"').join(', ') +
        ' will come out as garbled symbols in your download, even though it looks right here in the preview. ' +
        "We're sorry about that — wider language support is on our list.";
    } else {
      els.charsetWarning.hidden = true;
      els.charsetWarning.textContent = '';
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
  function updateDownloadHint() {
    if (els.downloadError && !els.downloadError.hidden) {
      els.downloadHint.textContent = '';
      return;
    }
    // Without this, a Prev/Next click mid-generation (renderPreview() calls
    // this) would overwrite the "Generating…" hint with "ready"/"fill in the
    // required prompts" text right next to a button that still literally
    // reads "Generating your book…" — the same disagreeing-UI-regions class
    // already fixed for other banners.
    if (isGeneratingPdf) {
      els.downloadHint.textContent = 'Generating your book — this can take a few seconds for a longer story.';
      return;
    }
    if (pendingPhotoUploads > 0) {
      els.downloadHint.textContent = "Still processing your photo — just a moment.";
      return;
    }
    els.downloadHint.textContent = els.downloadBtn.disabled
      ? 'Fill in the required prompts above to unlock your download.'
      : 'Your book is ready.';
  }

  function movePreview(delta) {
    state.previewIndex += delta;
    renderPreview();
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
          try {
            doc.saveGraphicsState();
            doc.circle(cx, cy, rad, null);
            doc.clip();
            doc.discardPath();
            doc.addImage(imgSrc, imgFormat, photoX, photoY, photoSize, photoSize, undefined, 'MEDIUM');
            doc.restoreGraphicsState();
          } catch (e) {
            // Corrupt/unsupported image data — skip the photo, keep the rest of the page intact.
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
