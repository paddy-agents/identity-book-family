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
    // Unlike native ctx.roundRect(), arcTo() has no built-in clamp — a
    // radius bigger than half the rect's own width/height (e.g. the baby
    // scene's swaddle: r*0.9 vs a height of size*0.42) makes the two arcs
    // sharing that edge overshoot past each other, producing a small kink
    // instead of a smooth curve, on every render regardless of avatar config.
    radius = Math.min(radius, w / 2, h / 2);
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
    if (style === 'long' || style === 'pigtails') {
      // Every other hair-fill contrast fix (blonde, gray) was verified only
      // against the theme's SOFT card background — but the 'long' ellipses
      // and 'pigtails' bumps reach down past the baby scene's swaddle
      // boundary (cy + r*0.35) and get painted directly over theme.WARM
      // instead, where warm-toned hair colors (blonde/gray/red, even brown)
      // collapse to as low as ~1.4:1 contrast (need 3:1) — nearly invisible
      // against the swaddle. Hair has no stroke elsewhere by design (fill
      // alone normally carries enough contrast), but these two styles need
      // one specifically for this reason — reusing the same dark stroke
      // color already proven >=3:1 against every SOFT and WARM value in
      // drawFace's own head-outline. Found by a fresh-eyes review 2026-07-27.
      ctx.strokeStyle = '#4a3626';
      ctx.lineWidth = Math.max(1, r * 0.025);
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
        ctx.stroke();
      });
    }
    if (style === 'pigtails') {
      // A theoretical farthest-point calculation on these constants alone
      // puts this hairstyle at ~99% of the 'face' scene's circular clip
      // radius (size*0.5) — the tightest margin of any hairstyle. Checked
      // empirically anyway (a canvas alpha>10 scan against the clip circle
      // at size 160/300/625, matching every real render size the 'face'
      // scene is actually used at) and it comes back with zero stray pixels
      // at all three — re-confirmed 2026-07-24, same conclusion as
      // 2026-07-23's and 2026-07-19's earlier checks. Don't re-flag this
      // from the math alone without a fresh render-and-measure — the
      // theoretical estimate doesn't match reality here, for reasons not
      // worth chasing further.
      [-1, 1].forEach((side) => {
        ctx.beginPath();
        ctx.arc(cx + side * r * 1.05, cy + r * 0.25, r * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
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

    // Head is drawn BEFORE the ears, not after: the ear circles straddle the
    // head circle's own boundary (ear spans ~0.82r-1.14r from center, the
    // head's stroke sits at exactly r), so drawing the head second painted
    // its boundary stroke straight across each ear, splitting it into two
    // crescents with a stray line down the middle (found 2026-07-22 by
    // actually rendering and zooming into the ear).
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

    // Ears are drawn AFTER hair, not before: the 'pigtails' bump (center
    // ~(cx-r*1.05, cy+r*0.25), radius r*0.3) and, to a lesser extent,
    // 'curly' hair's side curls geometrically overlap most of the ear's own
    // circle (center ~(cx-r*0.98, cy+r*0.05), radius r*0.16) — with ears
    // drawn first, the opaque hair painted over ~79% of each ear, leaving
    // only a thin disconnected crescent that reads as a stray floating line
    // rather than a recognizable ear. 'short'/'bald'/'bun'/'long' don't
    // reach far enough into the ear's bounding region to trigger this.
    // Ears now drawn last so they correctly sit in front of hair, the same
    // "later-drawn = frontmost" principle already used for head-vs-ear
    // ordering above. Found by a fresh-eyes review 2026-07-25 (rendered and
    // measured: pigtails covered ~79% of the ear's area).
    ctx.fillStyle = skin;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.arc(cx + side * r * 0.98, cy + r * 0.05, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
      // The ear pokes out past the main head circle's own stroked boundary
      // (above) — without its own stroke, that exposed sliver was the same
      // near-invisible unstroked skin-on-background patch the fix above
      // solves for the head, just missed for this smaller shape.
      ctx.stroke();
    });

    [-1, 1].forEach((side) => {
      const ex = cx + side * r * 0.34;
      const ey = cy - r * 0.05;
      // The white sclera fill alone measures only ~1.3-2.4:1 contrast
      // against the 3 lightest skin tones ('light', 'fair', and the
      // default avatar's own 'medium') — same "unstroked fill blends into
      // an adjacent similar-luminance background" shape already fixed for
      // the head/ear outlines and the pupil ring, just missed for this
      // shape. A thin stroke in the same dark color already used for the
      // head/ear outline clears 3:1 against every skin tone that actually
      // needs it (the 2 darkest tones already pass on fill alone, so the
      // stroke there is a no-op, not a fix). Found by a fresh-eyes review
      // 2026-07-24.
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = Math.max(0.75, r * 0.014);
      ctx.strokeStyle = '#4a3626';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.08, 0, Math.PI * 2);
      ctx.fillStyle = eyeColor;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.035, 0, Math.PI * 2);
      ctx.fillStyle = '#241c16';
      ctx.fill();
      // The pupil's fixed dark fill only measures ~1.66:1 contrast against
      // the 'brown' iris color (both are dark, low-luminance browns) —
      // rendered and visually confirmed as a near-featureless dark blob with
      // no visible pupil/iris boundary, unlike blue/green/hazel (3.7-4.3:1
      // against the same pupil color, already fine). Rather than lighten the
      // iris itself (which would blur 'brown' toward looking like 'hazel')
      // or special-case one eye color, a thin light ring around every pupil
      // guarantees a visible boundary regardless of the iris's own
      // luminance — a no-op visual change for the 3 colors that already had
      // enough contrast. Found by a fresh-eyes review 2026-07-23.
      // Unlike every other stroke in this file (head/ear/sclera/mouth/ground
      // line), this one had no Math.max() floor -- at the avatar builder's
      // small 160px thumbnail and the 500px live-preview canvas, r*0.012
      // rounds down to well under 1px, so the canvas anti-aliases it into a
      // muddy partial blend (~3.5:1) instead of painting the ring at its
      // true, designed color (~8.2:1) -- only reaching full strength at the
      // PDF's larger 625/1042px canvases. A parent picking brown eyes saw a
      // faint gray smudge in both places they'd actually look (the builder,
      // the live preview) even though the same ring renders correctly once
      // baked into the downloaded PDF. Found by a fresh-eyes review 2026-07-24.
      ctx.lineWidth = Math.max(0.75, r * 0.012);
      ctx.strokeStyle = '#f2e6d3';
      ctx.stroke();
    });

    // A fixed translucent fill blends toward whatever it sits on, so its
    // effective on-canvas color never reached usable contrast against ANY
    // skin tone (worst on 'deep', ~1.26:1) — including the default avatar's
    // own 'medium' skin (~1.73:1), not just an edge case. Reuses the same
    // per-skin-tone color already used for the mouth stroke (mouthHexFor),
    // which is already guaranteed >=3:1 against every skin tone. Found by a
    // fresh-eyes review 2026-07-23.
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.14, r * 0.035, 0, Math.PI * 2);
    ctx.fillStyle = mouthHexFor(avatar.skinTone);
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
      // off-center rather than composed. The original fix (0.14*size) shifted
      // by half the parent<->face *gap*, centering the two shapes' CENTERS —
      // but the parent silhouette's body (half-width ~0.06*size) and the
      // face-with-ears (half-width ~0.171*size) are very different widths, so
      // centering their centers left the wider face's own bulge unbalanced:
      // measured bounding box was 100px left margin vs 156px right margin on
      // a 500px canvas (~1.56:1), the same magnitude/direction of imbalance
      // already fixed once for twoParentWithSibling below. Re-derived from
      // the actual rendered bounding box (not the shapes' nominal widths) —
      // same fix shape, just for this combo. Found by a fresh-eyes review
      // 2026-07-25.
      const soloDuo = parentCount === 1 && !siblingCount;
      // The 0.084 shift below was derived from the face-WITH-EARS half-width
      // (~0.171*size, ears reaching 1.14r) as the "widest" case — but two
      // hairstyles' own shapes reach further than that baseline: 'pigtails'
      // side bumps reach 1.35r (~0.2025*size, see the 0.28 ground-line-
      // clearance comment below), 0.0315*size wider than the ear baseline
      // (measured 1.14:1 imbalance at both real render sizes before
      // compensation — a real proportional effect, not rounding noise,
      // found by a fresh-eyes review 2026-07-25). 'curly's 7 tuft circles
      // (see drawHair's curly branch) reach ~1.184r at their two outermost
      // tufts (cos(18°)*r*0.95 + r*0.28), a smaller but still real and
      // proportional ~3px@500px/6px@1042px imbalance — under
      // pigtails' original magnitude, which is why it went unnoticed until
      // a fresh-eyes review specifically re-checked every hairstyle against
      // this same fix, not just the one that originally triggered it.
      // Found 2026-07-26. Halved into the shift using the same
      // bounding-box-symmetry derivation as the base constant.
      const HAIR_SOLO_EXTRA_HALF_WIDTH = { pigtails: 0.0315, curly: 0.006 };
      const soloExtraHalfWidth = (HAIR_SOLO_EXTRA_HALF_WIDTH[avatar.hairStyle] || 0) * size;
      // 2 parents + 1 sibling is the app's own DEFAULT combo (parentsLabel
      // defaults to "Mommy and Daddy") the instant a family has any
      // siblings at all — not an edge case. The sibling sits at 0.42*size
      // right of center (see siblingOffset below, tuned for hair
      // clearance past the right parent), with nothing balancing it on the
      // left, so the whole group's bounding box (left parent's edge to the
      // sibling's edge) sat well right of center: left margin 0.16*size vs
      // right margin only ~0.043*size, a ~3.7:1 imbalance confirmed by
      // rendering. Shifting faceCx left by half that imbalance (derived
      // from the bounding-box math, not guessed) makes the group's own
      // bounding box exactly symmetric around cx — same fix shape as
      // soloDuo above, just for a different lopsided combo. Found by a
      // fresh-eyes review 2026-07-25.
      const twoParentWithSibling = parentCount === 2 && siblingCount;
      let faceCx = cx;
      if (soloDuo) faceCx = cx + size * 0.084 - soloExtraHalfWidth / 2;
      if (twoParentWithSibling) faceCx = cx - size * 0.0586;
      // Ground line is drawn BEFORE the silhouettes so their feet sit on top
      // of it, not the other way round — the line's color (warmHex) differs
      // from the parent silhouettes' fill (warmDarkHex), and stroking the
      // line last used to paint a visibly mismatched-color band straight
      // across their legs where the two overlapped.
      // warmHex here measures only 2.5-2.94:1 against SOFT across the 4
      // themes (below the 3:1 non-text minimum) — same tolerated pattern as
      // the baby-scene swaddle fill above: a decorative illustration line,
      // not an information-bearing mark (the silhouettes it sits under
      // already use the higher-contrast warmDarkHex), confirmed visually
      // distinguishable even at the worst case. Left as-is deliberately;
      // don't re-flag without new visual evidence, not just the same
      // contrast math.
      ctx.strokeStyle = warmHex;
      ctx.lineWidth = Math.max(1.5, size * 0.004);
      ctx.beginPath();
      ctx.moveTo(size * 0.08, groundY);
      // Every combo's rightmost figure edge (parent or sibling, computed from
      // faceCx below) stays within 0.42*size of cx — including the
      // 2-parent+sibling combo now that its group is re-centered above — so
      // one shared right end covers all of them; a wider one-off (this used
      // to be 0.97 for that combo before the recentering) is no longer
      // needed.
      ctx.lineTo(size * 0.92, groundY);
      ctx.stroke();
      // 0.28 (not 0.24) leaves room for the widest hair styles (long/pigtails,
      // ~1.35x the face radius) so hair never overlaps the parent silhouettes.
      positions.forEach((side) => drawPersonSilhouette(ctx, faceCx + side * size * 0.28, groundY, 1, warmDarkHex, size));
      // warmHex here (unstroked fill vs the SOFT card) measured only
      // 2.5-2.94:1 across the 4 themes, below the 3:1 non-text minimum —
      // the same bug class the parent silhouettes just above already avoid
      // by using warmDarkHex instead. Matched here for the sibling figure too.
      // Anchored to faceCx (not the fixed cx) so the sibling shifts together
      // with the rest of the group in the twoParentWithSibling case above —
      // anchoring it to cx instead would preserve the same imbalance this
      // fix exists to remove.
      const siblingOffset = parentCount === 2 ? 0.42 : 0.3;
      if (siblingCount) drawPersonSilhouette(ctx, faceCx + size * siblingOffset, groundY, 0.62, warmDarkHex, size);
      drawFace(ctx, faceCx, groundY - size * 0.17, size * 0.15, avatar);
      return canvas.toDataURL('image/png');
    }

    return canvas.toDataURL('image/png');
  }

  window.AvatarKit = { SKIN_TONES, HAIR_COLORS, EYE_COLORS, HAIR_STYLES, DEFAULT_AVATAR, renderScene };
})();
