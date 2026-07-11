(function () {
  const STORAGE_KEY = 'originStories:v1';

  const state = {
    storyType: null,
    answers: {},
    titleTouched: false,
    previewIndex: 0,
  };

  const els = {};

  document.addEventListener('DOMContentLoaded', init);

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
    els.startOverBtn = document.getElementById('start-over-btn');
    els.savedNote = document.getElementById('saved-note');

    renderStoryTypeCards();
    els.prevBtn.addEventListener('click', () => movePreview(-1));
    els.nextBtn.addEventListener('click', () => movePreview(1));
    els.downloadBtn.addEventListener('click', downloadBook);
    if (els.startOverBtn) els.startOverBtn.addEventListener('click', startOver);

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
    state.answers = saved.answers || {};
    state.titleTouched = !!saved.titleTouched;
    state.previewIndex = saved.previewIndex || 0;

    [...els.storyTypes.children].forEach((card) => {
      card.classList.toggle('selected', card.dataset.id === state.storyType);
    });
    els.formSection.hidden = false;
    renderFields();
    if (els.savedNote) els.savedNote.hidden = false;
    document.body.dataset.theme = state.storyType;
  }

  function saveProgress() {
    if (!state.storyType) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        storyType: state.storyType,
        answers: state.answers,
        titleTouched: state.titleTouched,
        previewIndex: state.previewIndex,
      }));
    } catch (e) {
      // localStorage unavailable (private browsing, quota, etc) — fail silently, nothing else changes.
    }
    if (els.savedNote) els.savedNote.hidden = false;
  }

  function startOver() {
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
    [...els.storyTypes.children].forEach((card) => {
      card.classList.remove('selected');
      card.setAttribute('aria-pressed', 'false');
    });
    els.formSection.hidden = true;
    if (els.savedNote) els.savedNote.hidden = true;
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
    const out = [];
    fields.forEach((f) => {
      if (f.id === 'numSiblings') {
        out.push(f);
        const n = parseInt(state.answers.numSiblings || f.default || '0', 10);
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
    els.fields.innerHTML = '';

    fields.forEach((f) => {
      const wrap = document.createElement('div');
      wrap.className = 'field';

      const label = document.createElement('label');
      label.textContent = f.label + (f.required ? '' : ' (optional)');
      label.setAttribute('for', 'field-' + f.id);
      wrap.appendChild(label);

      if (f.hint) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = f.hint;
        wrap.appendChild(hint);
      }

      if (f.type === 'photo') {
        wrap.appendChild(buildPhotoUpload(f));
        els.fields.appendChild(wrap);
        return;
      }

      if (f.type === 'avatar') {
        wrap.appendChild(buildAvatarBuilder(f));
        els.fields.appendChild(wrap);
        return;
      }

      const value = state.answers[f.id] !== undefined ? state.answers[f.id] : (f.default || '');
      let input;
      if (f.type === 'select') {
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
        input.placeholder = f.placeholder || '';
        if (f.maxLength) input.maxLength = f.maxLength;
      }
      input.id = 'field-' + f.id;
      input.value = value;
      state.answers[f.id] = value;

      input.addEventListener('input', onFieldChange(f, input));
      if (f.type === 'select') input.addEventListener('change', onFieldChange(f, input));

      wrap.appendChild(input);
      els.fields.appendChild(wrap);
    });

    if (focusedId) {
      const toFocus = document.getElementById(focusedId);
      if (toFocus) toFocus.focus();
    }
  }

  // Builds the file-input + thumbnail + remove-button control for a 'photo'
  // field. Handled separately from the generic select/text inputs above
  // because a <input type=file> can't be pre-filled with a value — the
  // stored data URL lives only in state.answers.childPhoto.
  function buildPhotoUpload(f) {
    const uploadWrap = document.createElement('div');
    uploadWrap.className = 'photo-upload';
    const current = state.answers[f.id];

    const thumb = document.createElement('img');
    thumb.className = 'photo-thumb';
    thumb.hidden = !current;
    if (current) thumb.src = current;
    uploadWrap.appendChild(thumb);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.id = 'field-' + f.id;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      cropPhotoToSquare(file, (dataUrl) => {
        state.answers[f.id] = dataUrl;
        renderFields();
        renderPreview();
        saveProgress();
      });
    });
    uploadWrap.appendChild(fileInput);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'link-btn';
    removeBtn.textContent = 'Remove photo';
    removeBtn.hidden = !current;
    removeBtn.addEventListener('click', () => {
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
  // alongside the rest of the answers (a few hundred KB at most).
  function cropPhotoToSquare(file, onDone) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const size = 500;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
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
  function buildAvatarBuilder(f) {
    ensureAvatarDefaults();
    const avatar = state.answers.childAvatar;
    const wrap = document.createElement('div');
    wrap.className = 'avatar-builder';

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

  function onFieldChange(f, input) {
    return () => {
      if (f.id === 'bookTitle') state.titleTouched = true;
      state.answers[f.id] = input.value;
      // numSiblings/parentsLabel changes may add/remove dependent fields.
      if (f.id === 'numSiblings' || f.id === 'parentsLabel') {
        renderFields();
      }
      renderPreview();
      saveProgress();
    };
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
    // Custom entries commonly use "and", "&", or a comma to join caregivers
    // (e.g. "Grandma and Grandpa", "Grandma & Grandpa", "Grandma, Grandpa").
    return raw.split(/\s*,\s*|\s+&\s+|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  }

  function getSiblingNames(a) {
    const n = parseInt(a.numSiblings || '0', 10);
    const names = [];
    for (let i = 1; i <= n; i++) {
      if (a['siblingName' + i] && a['siblingName' + i].trim()) names.push(a['siblingName' + i].trim());
    }
    return names;
  }

  function buildPages() {
    ensureAvatarDefaults();
    const a = state.answers;
    const st = STORY_TYPES.find((s) => s.id === state.storyType) || STORY_TYPES[0];
    const name = a.childName && a.childName.trim() ? a.childName.trim() : 'you';
    const title = a.bookTitle && a.bookTitle.trim() ? a.bookTitle.trim() : st.defaultTitle;
    const season = a.season || 'spring';
    const parents = getParentsList(a);
    const siblings = getSiblingNames(a);
    const pet = a.petName && a.petName.trim() ? a.petName.trim() : '';
    const parentsPhrase = joinWithAnd(parents) || 'a family';

    const members = [
      ...parents.map((p) => 'a ' + p),
      ...siblings.map((s) => 'a ' + s),
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
      text: 'Once upon a ' + season + '-time, there was ' + (joinWithAnd(members) || 'a family') + '.',
      motif: 'moon-stars',
    });

    pages.push({ kind: 'text', text: 'They loved their family, but something was missing!', motif: 'heart-outline' });

    pages.push({ kind: 'text', label: 'Then, they had a great idea…', text: st.ideaLabel + '!', motif: 'lightbulb' });

    pages.push({ kind: 'text', label: 'How ' + name + ' joined our family', text: buildOriginSentence(state.storyType, a, name, parentsPhrase), motif: 'house-heart' });

    if (a.joyfulDetail && a.joyfulDetail.trim()) {
      pages.push({ kind: 'text', label: 'A joyful detail', text: a.joyfulDetail.trim(), motif: 'sparkle' });
    }

    if ((a.travelPlace && a.travelPlace.trim()) || (a.travelDuration && a.travelDuration.trim())) {
      let text = parentsPhrase + ' traveled';
      if (a.travelPlace && a.travelPlace.trim()) text += ' to ' + a.travelPlace.trim();
      if (a.travelDuration && a.travelDuration.trim()) text += ' — ' + a.travelDuration.trim() + ' of waiting and love';
      text += ' to meet ' + name + '.';
      pages.push({ kind: 'text', label: 'The journey', text: text, motif: 'plane' });
    }

    pages.push({
      kind: 'text',
      text: parentsPhrase + ' could not believe their great blessing the very first time they held ' + name + '.',
      motif: 'heart',
    });

    if (siblings.length) {
      pages.push({
        kind: 'text',
        text: joinWithAnd(siblings) + ' could not stop hugging and kissing ' + name + ', so happy the wait was over!',
        motif: 'two-hearts',
      });
    }

    pages.push({ kind: 'text', text: 'Then, everyone headed home, eager to share their happy news with the whole family!', motif: 'house' });

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
      const detail = a.helperDetail && a.helperDetail.trim() ? a.helperDetail.trim() : 'doctors helped us';
      return parentsPhrase + ' wanted ' + name + ' so much — ' + detail + ', and then, there ' + name + ' was!';
    }
    if (storyTypeId === 'blended') {
      const how = a.howCame && a.howCame.trim() ? a.howCame.trim() : 'we met, fell in love, and became one family';
      return parentsPhrase + ' ' + how + ', and that is how our family grew.';
    }
    // adoption (default)
    const term = a.birthParentTerm || 'birth mom';
    return 'A ' + term + ' loved ' + name + ' so much that they chose ' + parentsPhrase + ' to be ' + name + "'s family, forever.";
  }

  function renderPreview() {
    const pages = buildPages();
    if (state.previewIndex >= pages.length) state.previewIndex = pages.length - 1;
    if (state.previewIndex < 0) state.previewIndex = 0;
    const page = pages[state.previewIndex];

    els.preview.innerHTML = '';
    if (page.kind === 'title') {
      const photoSrc = page.photo || (page.useAvatar ? avatarSceneFor('face', 300) : null);
      if (photoSrc) {
        const img = document.createElement('img');
        img.className = 'preview-photo';
        img.src = photoSrc;
        els.preview.appendChild(img);
      }
      const t = document.createElement('div');
      t.className = 'page-title';
      t.textContent = page.title;
      const s = document.createElement('div');
      s.className = 'page-text';
      s.style.marginTop = '0.8rem';
      s.style.fontSize = '1.05rem';
      s.textContent = page.subtitle;
      els.preview.appendChild(t);
      els.preview.appendChild(s);
    } else if (page.kind === 'baby-portrait' || page.kind === 'family-portrait') {
      if (page.label) {
        const l = document.createElement('div');
        l.className = 'page-label-inline';
        l.textContent = page.label;
        els.preview.appendChild(l);
      }
      const img = document.createElement('img');
      img.className = 'preview-scene';
      img.src = avatarSceneFor(page.kind === 'baby-portrait' ? 'baby' : 'family', 500);
      els.preview.appendChild(img);
      const s = document.createElement('div');
      s.className = 'page-text';
      s.style.fontSize = '1rem';
      s.textContent = page.text;
      els.preview.appendChild(s);
    } else {
      if (page.label) {
        const l = document.createElement('div');
        l.className = 'page-label-inline';
        l.textContent = page.label;
        els.preview.appendChild(l);
      }
      const s = document.createElement('div');
      s.className = 'page-text';
      s.textContent = page.text;
      els.preview.appendChild(s);
    }

    els.pageLabel.textContent = 'Page ' + (state.previewIndex + 1) + ' of ' + pages.length +
      (page.label ? ' — ' + page.label : '');
    els.prevBtn.disabled = state.previewIndex === 0;
    els.nextBtn.disabled = state.previewIndex === pages.length - 1;

    els.downloadBtn.disabled = !state.storyType || !allRequiredFilled();
    els.downloadHint.textContent = els.downloadBtn.disabled
      ? 'Fill in the required prompts above to unlock your download.'
      : 'Your book is ready.';
  }

  function allRequiredFilled() {
    return getVisibleFields().every((f) => !f.required || (state.answers[f.id] && state.answers[f.id].trim()));
  }

  function movePreview(delta) {
    state.previewIndex += delta;
    renderPreview();
    saveProgress();
  }

  // Shrinks font size until the wrapped text fits within maxHeight (or hits
  // minSize) — a safety net so an unusually long combination of answers
  // (e.g. several sibling names plus a pet) can't overflow off the page.
  function fitTextBlock(doc, text, maxWidth, maxHeight, opts) {
    let fontSize = opts.startSize;
    const minSize = opts.minSize;
    let lines, lineHeight, blockHeight;
    while (true) {
      doc.setFontSize(fontSize);
      lines = doc.splitTextToSize(text, maxWidth);
      lineHeight = fontSize * 1.37;
      blockHeight = lines.length * lineHeight;
      if (blockHeight <= maxHeight || fontSize <= minSize) break;
      fontSize -= 1;
    }
    return { lines, fontSize, lineHeight, blockHeight };
  }

  function downloadBook() {
    const pages = buildPages();
    const theme = themeFor(state.storyType);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
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
          const imgSrc = page.photo || avatarSceneFor('face', 300);
          const imgFormat = page.photo ? 'JPEG' : 'PNG';
          try {
            doc.saveGraphicsState();
            doc.circle(cx, cy, rad, null);
            doc.clip();
            doc.discardPath();
            doc.addImage(imgSrc, imgFormat, photoX, photoY, photoSize, photoSize);
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
        });
        doc.setTextColor(51, 41, 31);
        const titleBaseline = titleTop + title.lineHeight;
        doc.text(title.lines, pageWidth / 2, titleBaseline, { align: 'center', lineHeightFactor: 1.3 });
        const titleBottom = titleBaseline + (title.lines.length - 1) * title.lineHeight;

        doc.setFont('times', 'italic');
        const subtitle = fitTextBlock(doc, page.subtitle, maxWidth, bottomLimit - titleBottom - 24, {
          startSize: 16,
          minSize: 11,
        });
        const subtitleBaseline = titleBottom + 24 + subtitle.lineHeight;
        doc.text(subtitle.lines, pageWidth / 2, subtitleBaseline, { align: 'center', lineHeightFactor: 1.3 });
      } else if (page.kind === 'baby-portrait' || page.kind === 'family-portrait') {
        let labelBottom = iconY + 40;
        if (page.label) {
          doc.setFont('times', 'bolditalic');
          doc.setTextColor(theme.WARM_DARK[0], theme.WARM_DARK[1], theme.WARM_DARK[2]);
          const label = fitTextBlock(doc, page.label, maxWidth, 60, { startSize: 13, minSize: 9 });
          const labelBaseline = iconY + 44;
          doc.text(label.lines, pageWidth / 2, labelBaseline, { align: 'center', lineHeightFactor: 1.2 });
          doc.setTextColor(51, 41, 31);
          labelBottom = labelBaseline + (label.lines.length - 1) * label.lineHeight * 1.2 + 16;
        }
        const imgSize = 250;
        const imgX = pageWidth / 2 - imgSize / 2;
        const imgY = labelBottom + 14;
        try {
          const sceneUrl = avatarSceneFor(page.kind === 'baby-portrait' ? 'baby' : 'family', 500);
          doc.addImage(sceneUrl, 'PNG', imgX, imgY, imgSize, imgSize);
        } catch (e) {
          // Canvas rendering unsupported — skip the illustration, keep the caption.
        }
        doc.setFont('times', 'normal');
        doc.setTextColor(51, 41, 31);
        const captionTop = imgY + imgSize + 22;
        const body = fitTextBlock(doc, page.text, maxWidth, bottomLimit - captionTop, {
          startSize: 15,
          minSize: 10,
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
          const label = fitTextBlock(doc, page.label, maxWidth, 60, { startSize: 13, minSize: 9 });
          const labelBaseline = iconY + 44;
          doc.text(label.lines, pageWidth / 2, labelBaseline, { align: 'center', lineHeightFactor: 1.2 });
          doc.setTextColor(51, 41, 31);
          labelBottom = labelBaseline + (label.lines.length - 1) * label.lineHeight * 1.2 + 16;
        }
        doc.setFont('times', 'normal');
        const body = fitTextBlock(doc, page.text, maxWidth, bottomLimit - labelBottom, {
          startSize: 19,
          minSize: 10,
        });
        let startY = pageHeight / 2 - body.blockHeight / 2 + body.lineHeight;
        if (startY < labelBottom + body.lineHeight) startY = labelBottom + body.lineHeight;
        doc.text(body.lines, pageWidth / 2, startY, {
          align: 'center',
          lineHeightFactor: 1.4,
        });
      }
    });

    const name = (state.answers.childName || 'origin-story').trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents (e.g. "Siobhán" -> "Siobhan") instead of turning them into stray hyphens
      .replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    doc.save(name + '-origin-story.pdf');
  }

  // --- decorative vector motifs (kept as simple shape primitives, no image assets) ---

  const INK = [51, 41, 31];

  // Per-story-type accent palettes. Kept in sync with the WARM/WARM-DARK/SOFT/
  // CREAM custom properties in css/style.css so the live preview and the
  // downloaded PDF use matching colors. INK (body text) stays constant.
  const THEMES = {
    adoption: { WARM: [201, 113, 58], WARM_DARK: [168, 90, 42], SOFT: [238, 225, 207], CREAM: [251, 246, 239] },
    surrogacy: { WARM: [90, 140, 150], WARM_DARK: [58, 102, 112], SOFT: [204, 226, 228], CREAM: [242, 248, 247] },
    ivf: { WARM: [142, 110, 168], WARM_DARK: [104, 74, 130], SOFT: [223, 210, 232], CREAM: [248, 244, 251] },
    blended: { WARM: [124, 148, 96], WARM_DARK: [90, 112, 64], SOFT: [216, 226, 200], CREAM: [247, 249, 241] },
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
    doc.setFillColor(theme.CREAM[0], theme.CREAM[1], theme.CREAM[2]);
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
    doc.setFillColor(theme.CREAM[0], theme.CREAM[1], theme.CREAM[2]);
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
})();
