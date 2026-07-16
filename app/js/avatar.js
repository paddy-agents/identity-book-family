/*
 * Simple cartoon avatar builder — canvas-drawn (not SVG), so the exact same
 * rasterized PNG data URL can be used both for the live HTML preview (as an
 * <img> src) and embedded directly into the jsPDF download via addImage().
 * One drawing routine, two consumers, always in sync — see js/app.js
 * avatarSceneFor().
 */
(function () {
  const SKIN_TONES = [
    { id: 'light', hex: '#f6d9be' },
    { id: 'fair', hex: '#eec39a' },
    { id: 'medium', hex: '#cf9d68' },
    { id: 'tan', hex: '#a86e42' },
    { id: 'deep', hex: '#7a4a2c' },
  ];
  const HAIR_COLORS = [
    { id: 'black', hex: '#2b2320' },
    { id: 'brown', hex: '#5b3a29' },
    { id: 'blonde', hex: '#d8b46a' },
    { id: 'red', hex: '#a24a2a' },
    { id: 'gray', hex: '#b8b0a6' },
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

    ctx.fillStyle = skin;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.arc(cx + side * r * 0.98, cy + r * 0.05, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();

    drawHair(ctx, cx, cy, r, avatar.hairStyle, hairColor);

    ctx.fillStyle = 'rgba(220,120,110,0.28)';
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.arc(cx + side * r * 0.45, cy + r * 0.32, r * 0.14, 0, Math.PI * 2);
      ctx.fill();
    });

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
    ctx.strokeStyle = '#7a3f2c';
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
      const siblingCount = opts.siblingCount ? 1 : 0;
      const positions = parentCount === 2 ? [-1, 1] : [-1];
      // 0.28 (not 0.24) leaves room for the widest hair styles (long/pigtails,
      // ~1.35x the face radius) so hair never overlaps the parent silhouettes.
      positions.forEach((side) => drawPersonSilhouette(ctx, cx + side * size * 0.28, groundY, 1, warmDarkHex, size));
      if (siblingCount) drawPersonSilhouette(ctx, cx + size * (parentCount === 2 ? 0.42 : 0.3), groundY, 0.62, warmHex, size);
      ctx.strokeStyle = warmHex;
      ctx.lineWidth = Math.max(1.5, size * 0.004);
      ctx.beginPath();
      ctx.moveTo(size * 0.08, groundY);
      ctx.lineTo(size * 0.92, groundY);
      ctx.stroke();
      drawFace(ctx, cx, groundY - size * 0.17, size * 0.15, avatar);
      return canvas.toDataURL('image/png');
    }

    return canvas.toDataURL('image/png');
  }

  window.AvatarKit = { SKIN_TONES, HAIR_COLORS, EYE_COLORS, HAIR_STYLES, DEFAULT_AVATAR, renderScene };
})();
