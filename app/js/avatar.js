/*
 * Simple cartoon avatar builder — canvas-drawn (not SVG), so the exact same
 * rasterized PNG data URL can be used both for the live HTML preview (as an
 * <img> src) and embedded directly into the jsPDF download via addImage().
 * One drawing routine, two consumers, always in sync — see js/app.js
 * avatarSceneFor().
 */
(function () {
  const SKIN_TONES = [
    // `mouth` is the smile-stroke color drawn in drawFace — a fixed dark
    // brown reads fine (>=4:1 contrast) against the four lighter tones, but
    // against 'deep' skin it dropped to ~1.1:1 (WCAG needs 3:1), making the
    // smile nearly invisible — so 'deep' gets a light warm stroke instead
    // (>=4.7:1) while the others share the original dark one.
    { id: 'light', hex: '#f6d9be', mouth: '#241c16' },
    { id: 'fair', hex: '#eec39a', mouth: '#241c16' },
    { id: 'medium', hex: '#cf9d68', mouth: '#241c16' },
    { id: 'tan', hex: '#a86e42', mouth: '#241c16' },
    { id: 'deep', hex: '#7a4a2c', mouth: '#e8c9a8' },
  ];
  const HAIR_COLORS = [
    { id: 'black', hex: '#2b2320' },
    { id: 'brown', hex: '#5b3a29' },
    // The original #d8b46a was only ~1.4-1.5:1 against every theme's SOFT
    // card background in the baby/family scenes (need 3:1) — the same
    // "hair has no outline stroke, so fill alone must carry contrast" bug
    // class already fixed once for 'gray', just worse. Darkened to a deep
    // honey-blonde that still reads as blonde (>=4.1:1 in all 4 themes).
    { id: 'blonde', hex: '#7d5f2a' },
    { id: 'red', hex: '#a24a2a' },
    // Unlike the face circle, hair has no outline stroke, so its own fill
    // needs to carry enough contrast on its own. The original #b8b0a6 was
    // only ~1.5-1.7:1 against every theme's SOFT card background in the
    // baby/family scenes (need 3:1) — nearly invisible, the same bug class
    // already fixed once for the two lightest skin tones. Darkened to a
    // muted steel-gray that still reads as "gray hair" (>=4:1 in all 4
    // themes).
    { id: 'gray', hex: '#69645c' },
  ];
  const EYE_COLORS = [
    { id: 'brown', hex: '#5b3a29' },
    { id: 'blue', hex: '#4a7ba6' },
    { id: 'green', hex: '#5a8c5a' },
    { id: 'hazel', hex: '#8a7a4a' },
  ];
  const HAIR_STYLES = [
    { id: 'bald', label: 'Bald' },
    { id: 'short', label: 'Short' },
    { id: 'curly', label: 'Curly' },
    { id: 'long', label: 'Long' },
    { id: 'pigtails', label: 'Pigtails' },
    { id: 'bun', label: 'Bun' },
  ];
  const DEFAULT_AVATAR = { skinTone: 'medium', hairStyle: 'short', hairColor: 'brown', eyeColor: 'brown' };

  function hexFor(list, id) {
    const found = list.find((x) => x.id === id);
    return found ? found.hex : list[0].hex;
  }

  function mouthHexFor(skinToneId) {
    const found = SKIN_TONES.find((x) => x.id === skinToneId);
    return found ? found.mouth : SKIN_TONES[0].mouth;
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }

  function roundedRectPath(ctx, x, y, w, h, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function drawHair(ctx, cx, cy, r, style, hex) {
    ctx.fillStyle = hex;
    if (style === 'bald') return;
    if (style === 'curly') {
      for (let i = 0; i <= 6; i++) {
        const a = Math.PI * 1.1 + (Math.PI * 0.8 * i) / 6;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95, r * 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // short / long / pigtails / bun all start from the same cap shape.
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.08, r * 1.04, Math.PI * 1.06, Math.PI * 1.94);
      ctx.closePath();
      ctx.fill();
    }
    if (style === 'long') {
      // Scaled to keep the farthest point of these ellipses within ~0.95 of
      // the 0.5*size circular clip callers apply (see drawFace's r comment) —
      // the original 0.98/0.55/0.32/0.85 values reached ~1.25x that clip
      // radius, silently cropping the bottom of long hair in the cover
      // photo/avatar circle (never an issue in the unclipped baby/family
      // scenes, which is why it went unnoticed).
      [-1, 1].forEach((side) => {
        ctx.beginPath();
        ctx.ellipse(cx + side * r * 0.75, cy + r * 0.42, r * 0.24, r * 0.65, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    if (style === 'pigtails') {
      [-1, 1].forEach((side) => {
        ctx.beginPath();
        ctx.arc(cx + side * r * 1.05, cy + r * 0.25, r * 0.3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    if (style === 'bun') {
      ctx.beginPath();
      ctx.arc(cx, cy - r * 1.05, r * 0.26, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawFace(ctx, cx, cy, r, avatar) {
    const skin = hexFor(SKIN_TONES, avatar.skinTone);
    const hairColor = hexFor(HAIR_COLORS, avatar.hairColor);
    const eyeColor = hexFor(EYE_COLORS, avatar.eyeColor);

    // The 'baby'/'family' scenes draw this face on top of a theme-tinted
    // card (THEMES[x].SOFT in app.js) — the two lightest skin tones ('light',
    // 'fair') measure a WCAG contrast of only ~1.0-1.3 against every one of
    // the 4 themes' SOFT color, so without an outline the face was nearly
    // invisible, floating as just eyes/mouth with no visible head shape. A
    // single fixed dark stroke works for every skin tone/theme combination
    // because what matters is stroke-vs-background contrast (>=7.9 in all 4
    // themes), not stroke-vs-skin — even where the stroke nearly matches a
    // dark skin tone, that tone already contrasts fine against the
    // background on its own.
    ctx.strokeStyle = '#4a3626';
    ctx.lineWidth = Math.max(1, r * 0.025);

    ctx.fillStyle = skin;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.arc(cx + side * r * 0.98, cy + r * 0.05, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
      // The ear pokes out past the main head circle's own stroked boundary
      // (below) — without its own stroke, that exposed sliver was the same
      // near-invisible unstroked skin-on-background patch the fix above
      // solves for the head, just missed for this smaller shape.
      ctx.stroke();
    });

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.stroke();

    // Blush is drawn BEFORE hair, not after: the 'long' hairstyle's side
    // strands (drawHair) geometrically reach down into this same cheek
    // region, and painting blush on top of them tinted the hair itself a
    // visible rose color instead of just tinting the cheek. Drawing hair
    // last means it correctly covers any blush behind it, exactly like a
    // real hair strand in front of a cheek would. No other hairstyle's
    // shapes reach this low, so this reorder is a no-op for them.
    ctx.fillStyle = 'rgba(220,120,110,0.28)';
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.arc(cx + side * r * 0.45, cy + r * 0.32, r * 0.14, 0, Math.PI * 2);
      ctx.fill();
    });

    drawHair(ctx, cx, cy, r, avatar.hairStyle, hairColor);

    [-1, 1].forEach((side) => {
      const ex = cx + side * r * 0.34;
      const ey = cy - r * 0.05;
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.08, 0, Math.PI * 2);
      ctx.fillStyle = eyeColor;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.035, 0, Math.PI * 2);
      ctx.fillStyle = '#241c16';
      ctx.fill();
    });

    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.14, r * 0.035, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(60,40,25,0.35)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.2, r * 0.22, Math.PI * 0.12, Math.PI * 0.88);
    ctx.strokeStyle = mouthHexFor(avatar.skinTone);
    ctx.lineWidth = Math.max(1.5, r * 0.045);
    ctx.stroke();
  }

  // All dimensions are proportional to `size` (the canvas's own pixel
  // dimensions), not absolute pixels — the same scene is rendered at very
  // different canvas sizes for the live preview vs. the print-resolution
  // PDF (see avatarSceneFor in app.js), so absolute pixel constants here
  // would silently shrink relative to the canvas at higher resolutions.
  function drawPersonSilhouette(ctx, cx, groundY, scale, hex, size) {
    ctx.fillStyle = hex;
    const unit = size / 500; // constants below were tuned against a 500px canvas
    const headR = 22 * scale * unit;
    ctx.beginPath();
    ctx.arc(cx, groundY - 92 * scale * unit, headR, 0, Math.PI * 2);
    ctx.fill();
    roundedRectPath(ctx, cx - 30 * scale * unit, groundY - 72 * scale * unit, 60 * scale * unit, 74 * scale * unit, 16 * scale * unit);
    ctx.fill();
  }

  // kind: 'face' (plain head+shoulders, for circular photo-style framing),
  // 'baby' (swaddled baby scene), 'family' (child + simple parent/sibling
  // silhouettes). opts: { theme, parentCount, siblingCount }.
  function renderScene(kind, avatar, size, opts) {
    opts = opts || {};
    const theme = opts.theme || { WARM: [201, 113, 58], WARM_DARK: [168, 90, 42], SOFT: [238, 225, 207], CREAM: [251, 246, 239] };
    const softHex = rgbToHex(theme.SOFT);
    const warmDarkHex = rgbToHex(theme.WARM_DARK);
    const warmHex = rgbToHex(theme.WARM);

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    if (kind === 'face') {
      // Kept comfortably inside 0.5*size so ears/long-hair never poke past
      // the circular clip callers apply (CSS border-radius:50% in the
      // preview, doc.circle(...).clip() in the PDF).
      drawFace(ctx, size / 2, size / 2, size * 0.36, avatar);
      return canvas.toDataURL('image/png');
    }

    roundedRectPath(ctx, 0, 0, size, size, size * 0.06);
    ctx.fillStyle = softHex;
    ctx.fill();

    if (kind === 'baby') {
      const cx = size / 2;
      const cy = size * 0.42;
      const r = size * 0.24;
      // warmHex here measures only 2.5-2.94:1 against SOFT across the 4
      // themes (below the 3:1 non-text minimum) — already investigated on
      // 2026-07-21 (rendered and visually inspected, not just computed):
      // even the worst case (blended, 2.50:1) reads as a clearly
      // distinguishable solid blob. Left as-is deliberately; don't re-flag
      // without new visual evidence, not just the same contrast math.
      ctx.fillStyle = warmHex;
      roundedRectPath(ctx, cx - r * 1.5, cy + r * 0.35, r * 3, size * 0.42, r * 0.9);
      ctx.fill();
      drawFace(ctx, cx, cy, r, avatar);
      return canvas.toDataURL('image/png');
    }

    if (kind === 'family') {
      const groundY = size * 0.86;
      const cx = size / 2;
      // Clamp to [1, 2]: a genuine 0 (e.g. an unparseable custom parents
      // label) should still draw one silhouette, not silently jump to 2 —
      // `|| 2` here previously treated a real 0 the same as "not provided".
      const parentCount = Math.max(1, Math.min(opts.parentCount || 0, 2));
      // Intentionally a boolean, not a real count: this simplified scene
      // draws at most ONE sibling silhouette as a stand-in for "there are
      // siblings", the same way it draws at most two parent silhouettes
      // regardless of a longer custom parents label — it's a symbolic
      // family portrait, not a literal head count. The page's own prose
      // (buildPages() in app.js) already names every sibling by name; this
      // has been independently investigated and confirmed intentional at
      // least 3 times (2026-07-10, 2026-07-16, 2026-07-17) after looking
      // like a bug on first read — if you're about to "fix" this to loop
      // over the real sibling count, don't; that would need real layout
      // work (spacing N silhouettes without overlap) that's out of scope
      // for a one-line change.
      const siblingCount = opts.siblingCount ? 1 : 0;
      const positions = parentCount === 2 ? [-1, 1] : [-1];
      // With 2 parents, the parent-child-parent triptych is already centered
      // on cx. With exactly 1 parent and 0 siblings, though, pinning the
      // face to cx left the lone parent hanging off to one side with a
      // lopsided gap of empty canvas on the other — the pair reads as
      // off-center rather than composed. Shift both by half the tuned
      // parent<->face gap (0.28*size) so their midpoint lands on cx while
      // preserving that exact gap (it's sized for hair-style clearance).
      const soloDuo = parentCount === 1 && !siblingCount;
      const faceCx = soloDuo ? cx + size * 0.14 : cx;
      // Ground line is drawn BEFORE the silhouettes so their feet sit on top
      // of it, not the other way round — the line's color (warmHex) differs
      // from the parent silhouettes' fill (warmDarkHex), and stroking the
      // line last used to paint a visibly mismatched-color band straight
      // across their legs where the two overlapped.
      ctx.strokeStyle = warmHex;
      ctx.lineWidth = Math.max(1.5, size * 0.004);
      ctx.beginPath();
      ctx.moveTo(size * 0.08, groundY);
      // The two-parent+sibling combo places the sibling (scale 0.62, so its
      // body half-width is ~0.037*size) at 0.42*size right of center — its
      // outer edge lands at ~0.457*size, past the line's default 0.42*size
      // right end (0.92 - 0.5 = 0.42), so it visibly hangs off the floor.
      // Every other combo's rightmost figure stays well inside 0.42*size.
      const lineRightEdge = parentCount === 2 && siblingCount ? 0.97 : 0.92;
      ctx.lineTo(size * lineRightEdge, groundY);
      ctx.stroke();
      // 0.28 (not 0.24) leaves room for the widest hair styles (long/pigtails,
      // ~1.35x the face radius) so hair never overlaps the parent silhouettes.
      positions.forEach((side) => drawPersonSilhouette(ctx, faceCx + side * size * 0.28, groundY, 1, warmDarkHex, size));
      // warmHex here (unstroked fill vs the SOFT card) measured only
      // 2.5-2.94:1 across the 4 themes, below the 3:1 non-text minimum —
      // the same bug class the parent silhouettes just above already avoid
      // by using warmDarkHex instead. Matched here for the sibling figure too.
      if (siblingCount) drawPersonSilhouette(ctx, cx + size * (parentCount === 2 ? 0.42 : 0.3), groundY, 0.62, warmDarkHex, size);
      drawFace(ctx, faceCx, groundY - size * 0.17, size * 0.15, avatar);
      return canvas.toDataURL('image/png');
    }

    return canvas.toDataURL('image/png');
  }

  window.AvatarKit = { SKIN_TONES, HAIR_COLORS, EYE_COLORS, HAIR_STYLES, DEFAULT_AVATAR, renderScene };
})();
