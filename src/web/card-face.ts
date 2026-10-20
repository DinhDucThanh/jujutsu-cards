/**
 * The card as the battle grid draws it. Shared with the courtroom so a card looks the same
 * wherever it appears: one DOM shape, one set of classes, one stylesheet.
 */

/**
 * One-glyph identity mark per fighter and per summon. Stands in for character art, so a
 * revealed card is instantly recognisable with no image assets to load or break.
 */
export const SUBJECT_GLYPH: Readonly<Record<string, string>> = {
  satoru_gojo: '∞',
  sukuna: '呪',
  mahito: '躯',
  kento_nanami: '７３',
  nobara_kugisaki: '釘',
  yuji_itadori: '拳',
  aoi_todo: '拍',
  jogo: '炎',
  megumi_fushiguro: '影',
  kinji_hakari: '賭',
  divine_dog: '犬',
  ratio_blade: '刃',
  six_eyes: '眼',
};

/**
 * Planted-trap overlays, one per hazard state. Each is hidden until the card's `data-hazard`
 * selects it (see styles.css). Drawn on a 100 x 100 grid and centred on the card. Each SVG
 * animates itself with an idle loop.
 *
 * Every card builds its own copy, so the Ember gradient id is suffixed with `uid`. A gradient
 * inside a `display: none` SVG can fail to paint, so a shared id could resolve to a hidden copy.
 */
function hazardArt(uid: number): string {
  return `
  <svg class="hz-art hz-lava" viewBox="0 0 100 100" fill="none" focusable="false" xmlns="http://www.w3.org/2000/svg">
    <style>
      /*
       * The engine-side rule for every loop in this file: animate opacity and transform
       * only. A pulsing drop-shadow filter re-rasterizes the card on the CPU every frame,
       * which is what turned a full 36-card grid into a slideshow.
       * Each glow is a static gradient aura that is painted once and then only faded and
       * scaled by the GPU compositor, so the cursed energy still breathes exactly as
       * before while the main thread stays free.
       */
      @keyframes flapLeft {
        0%, 100% { transform: rotate(0deg) scaleY(1); }
        50% { transform: rotate(-22deg) scaleY(0.4); }
      }
      @keyframes flapRight {
        0%, 100% { transform: rotate(0deg) scaleY(1); }
        50% { transform: rotate(22deg) scaleY(0.4); }
      }
      @keyframes emberAura {
        0%, 100% { opacity: 0.35; transform: scale(0.92); }
        50% { opacity: 0.95; transform: scale(1.1); }
      }
      @keyframes emberCore {
        0%, 100% { transform: scale(1) rotate(0deg); }
        50% { transform: scale(1.05) rotate(-1.2deg); }
      }
      .wing-l { transform-origin: 50px 42px; animation: flapLeft 0.14s infinite ease-in-out; }
      .wing-r { transform-origin: 50px 42px; animation: flapRight 0.14s infinite ease-in-out; }
      .ember-aura { transform-origin: 50px 46px; animation: emberAura 1.8s infinite ease-in-out; }
      .ember-core { transform-origin: 50px 46px; animation: emberCore 1.8s infinite ease-in-out; }
    </style>
    <g class="ember-aura">
      <ellipse cx="50" cy="46" rx="34" ry="30" fill="url(#ember-aura-${uid})"/>
      <ellipse cx="50" cy="57" rx="19" ry="17" fill="url(#ember-heat-${uid})"/>
    </g>
    <path d="M10 88 L34 76 L52 82 L78 72 L92 86" stroke="#ea580c" stroke-width="2.2" stroke-linecap="round" opacity="0.7"/>
    <path d="M26 80 L38 88 M60 78 L68 86" stroke="#facc15" stroke-width="1.6" stroke-linecap="round"/>
    <g class="ember-core">
      <ellipse cx="50" cy="58" rx="8" ry="12" fill="url(#magma-${uid})"/>
      <ellipse cx="50" cy="42" rx="6" ry="6" fill="#431407" stroke="#ea580c" stroke-width="1.2"/>
      <circle cx="50" cy="33" r="4" fill="#27272a"/>
      <circle cx="48" cy="32" r="1.2" fill="#facc15"/>
      <circle cx="52" cy="32" r="1.2" fill="#facc15"/>
      <path d="M48 30 L45 24 M52 30 L55 24" stroke="#ea580c" stroke-width="1.4" stroke-linecap="round"/>
      <path class="wing-l" d="M50 42 C32 30 18 36 14 46 C24 50 38 46 50 44 Z" fill="#fef08a" fill-opacity="0.65" stroke="#f97316" stroke-width="1.2"/>
      <path class="wing-r" d="M50 42 C68 30 82 36 86 46 C76 50 62 46 50 44 Z" fill="#fef08a" fill-opacity="0.65" stroke="#f97316" stroke-width="1.2"/>
    </g>
    <defs>
      <radialGradient id="magma-${uid}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fef08a"/>
        <stop offset="60%" stop-color="#f97316"/>
        <stop offset="100%" stop-color="#991b1b"/>
      </radialGradient>
      <!-- The glow, pre-blurred into the paint: the pulse only fades and scales it. -->
      <radialGradient id="ember-aura-${uid}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#facc15" stop-opacity="0.75"/>
        <stop offset="45%" stop-color="#f97316" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="ember-heat-${uid}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fef08a" stop-opacity="0.9"/>
        <stop offset="100%" stop-color="#ea580c" stop-opacity="0"/>
      </radialGradient>
    </defs>
  </svg>
  <svg class="hz-art hz-seal" viewBox="0 0 100 100" fill="none" focusable="false" xmlns="http://www.w3.org/2000/svg">
    <style>
      /*
       * The float and the shockwave rings are pure transform/opacity: the drop-shadow
       * halo the sheet used to drag around is now the static aura behind it, and the
       * rings keep a fixed stroke so their pulse never re-rasterizes the card.
       */
      @keyframes talismanFloat {
        0%, 100% { transform: translateY(0) rotate(-2deg); }
        50% { transform: translateY(-4px) rotate(2deg); }
      }
      @keyframes sealAura {
        0%, 100% { opacity: 0.4; transform: scale(0.9); }
        50% { opacity: 1; transform: scale(1.08); }
      }
      @keyframes cePulseRing {
        0% { transform: scale(0.8); opacity: 0.9; }
        100% { transform: scale(1.4); opacity: 0; }
      }
      @keyframes cursedMiasma {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 0.85; }
      }
      .talisman-sheet {
        transform-origin: 50px 50px;
        animation: talismanFloat 2.8s infinite ease-in-out;
      }
      .seal-aura {
        transform-origin: 50px 50px;
        animation: sealAura 2.8s infinite ease-in-out;
      }
      .ce-ring-1 {
        transform-origin: 50px 50px;
        stroke-width: 2;
        animation: cePulseRing 2.2s infinite cubic-bezier(0.2, 0.7, 0.4, 1);
      }
      .ce-ring-2 {
        transform-origin: 50px 50px;
        stroke-width: 1.6;
        animation: cePulseRing 2.2s infinite cubic-bezier(0.2, 0.7, 0.4, 1);
        animation-delay: 1.1s;
      }
      .miasma-glow {
        animation: cursedMiasma 2s infinite ease-in-out;
      }
    </style>
    <defs>
      <radialGradient id="seal-aura-${uid}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#be123c" stop-opacity="0.55"/>
        <stop offset="55%" stop-color="#881337" stop-opacity="0.38"/>
        <stop offset="100%" stop-color="#4c0519" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- Deep Abyssal Red Cursed Aura Glow: static paint, animated only by fade and scale -->
    <circle class="seal-aura" cx="50" cy="50" r="42" fill="url(#seal-aura-${uid})"/>

    <!-- Radiating Cursed Energy Shockwave Rings -->
    <ellipse cx="50" cy="50" rx="32" ry="40" class="ce-ring-1" stroke="#f43f5e" fill="none"/>
    <ellipse cx="50" cy="50" rx="24" ry="32" class="ce-ring-2" stroke="#fb7185" fill="none"/>

    <!-- Rising Cursed Energy Smoke Trails -->
    <path d="M20 72 C14 52 24 34 30 18 M80 72 C86 52 76 34 70 18" stroke="#f43f5e" stroke-width="1.8" stroke-linecap="round" opacity="0.6" class="miasma-glow"/>

    <!-- Floating Authentic Jujutsu Talisman (Ofuda) -->
    <g class="talisman-sheet">
      <!-- Aged Parchment Paper Strip Body with Notched Bottom -->
      <path d="M31 12 L69 12 L69 82 L64 79 L59 83 L54 79 L49 83 L44 79 L39 83 L35 79 L31 83 Z" fill="#fef3c7" stroke="#b45309" stroke-width="2" stroke-linejoin="round"/>

      <!-- Inner Vermilion Talisman Border Frame -->
      <rect x="34" y="15" width="32" height="63" rx="1.5" stroke="#be123c" stroke-width="1.2" fill="none" stroke-dasharray="6 2"/>

      <!-- Header Cursed Stamp / Blood Seal Block -->
      <rect x="37" y="18" width="26" height="8" rx="1.5" fill="#881337"/>
      <circle cx="50" cy="22" r="2.2" fill="#fef08a"/>

      <!-- Margins Cursed Runes & Incantations -->
      <path d="M36 30 H39 M36 36 H38 M36 42 H39 M36 48 H38 M36 54 H39 M36 60 H38 M36 66 H39" stroke="#991b1b" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M64 30 H61 M64 36 H62 M64 42 H61 M64 48 H62 M64 54 H61 M64 60 H62 M64 66 H61" stroke="#991b1b" stroke-width="1.4" stroke-linecap="round"/>

      <!-- Central Sacred Character 封 with Inner Cursed Flame Backing -->
      <g transform="translate(0, 3)">
        <circle cx="50" cy="46" r="13" fill="#fecdd3" opacity="0.6"/>
        <text x="50" y="55" text-anchor="middle" fill="#7f1d1d" font-family="'Times New Roman', serif" font-weight="900" font-size="24" letter-spacing="1">封</text>
      </g>

      <!-- Bottom Talisman Binding Knot Glyphs -->
      <path d="M44 74 L50 78 L56 74 M50 71 V77" stroke="#be123c" stroke-width="1.6" stroke-linecap="round"/>
    </g>
  </svg>
  <svg class="hz-art hz-nail" viewBox="0 0 100 100" fill="none" focusable="false" xmlns="http://www.w3.org/2000/svg">
    <style>
      @keyframes nailAura {
        0%, 100% { opacity: 0.35; transform: scale(0.92); }
        50% { opacity: 0.95; transform: scale(1.1); }
      }
      @keyframes nailEnergy {
        0%, 100% { transform: scale(1) rotate(0deg); }
        50% { transform: scale(1.04) rotate(1.5deg); }
      }
      @keyframes sparkFloat {
        0% { transform: translateY(0) scale(0.8); opacity: 0; }
        50% { opacity: 1; }
        100% { transform: translateY(-8px) scale(1.2); opacity: 0; }
      }
      /* The iron never changes colour or blur: the ring of light behind it does the pulsing. */
      .nail-aura { transform-origin: 52px 50px; animation: nailAura 1.6s infinite ease-in-out; }
      .nail-energy { transform-origin: 52px 50px; animation: nailEnergy 1.6s infinite ease-in-out; }
      .nail-spark { animation: sparkFloat 2s infinite ease-in-out; }
    </style>
    <defs>
      <radialGradient id="nail-aura-${uid}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fb7185" stop-opacity="0.7"/>
        <stop offset="50%" stop-color="#be123c" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse class="nail-aura" cx="52" cy="50" rx="30" ry="33" fill="url(#nail-aura-${uid})"/>
    <path d="M64 64 L74 74 M66 60 L80 62 M60 66 L62 80 M56 56 L44 52" stroke="#fda4af" stroke-width="1.6" stroke-linecap="round" opacity="0.6"/>
    <g transform="rotate(-38 52 50)">
    <g class="nail-energy">
      <rect x="42" y="16" width="20" height="7" rx="2" fill="#e2e8f0" stroke="#475569" stroke-width="2"/>
      <path d="M47 23 L49 72 L52 84 L55 72 L57 23 Z" fill="#94a3b8" stroke="#334155" stroke-width="2" stroke-linejoin="round"/>
      <path d="M52 23 V80" stroke="#f8fafc" stroke-width="1.8" stroke-linecap="round"/>
      <circle class="nail-spark" cx="44" cy="40" r="2" fill="#f43f5e"/>
      <circle class="nail-spark" cx="60" cy="55" r="1.8" fill="#38bdf8" style="animation-delay: 0.7s;"/>
      <circle class="nail-spark" cx="48" cy="70" r="1.5" fill="#fb7185" style="animation-delay: 1.2s;"/>
    </g>
    </g>
  </svg>
  ${TRANSFIGURED_FLESH_ART.replace('<svg ', '<svg class="hz-art hz-soul" ')}`;
}

/**
 * Transfigured Flesh: the face a corrupted card shows in place of its fighter. A living,
 * breathing mass with a weeping eye, a screaming stitched jaw and dripping soul slime. It
 * fills the card's art area, so it is drawn on a 100 x 100 grid like the other emblems.
 */
export const TRANSFIGURED_FLESH_ART = `
<svg viewBox="0 0 100 100" fill="none" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <style>
    /*
     * The mass breathes through transform alone. Its violet halo is three stacked, static
     * translucent ellipses (.flesh-aura) that fade and swell under the mass; a pulsing
     * drop-shadow filter here repainted every corrupted card on every frame.
     */
    @keyframes fleshAura {
      0%, 100% { opacity: 0.4; transform: scale(0.94); }
      35% { opacity: 1; transform: scale(1.1); }
      70% { opacity: 0.65; transform: scale(1.02); }
    }
    @keyframes fleshThrob {
      0%, 100% { transform: scale(1) rotate(0deg); }
      35% { transform: scale(1.05, 0.95) rotate(-1.5deg); }
      70% { transform: scale(0.96, 1.04) rotate(1.2deg); }
    }
    @keyframes eyeTwitch {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.12); }
    }
    @keyframes jawTremble {
      0%, 100% { transform: translateY(0); }
      25% { transform: translateY(1.2px) rotate(0.8deg); }
      75% { transform: translateY(-0.8px) rotate(-0.5deg); }
    }
    @keyframes tendrilSquirm {
      0%, 100% { transform: rotate(0deg); }
      50% { transform: rotate(5deg) scaleX(1.08); }
    }
    .flesh-aura { transform-origin: 50px 52px; animation: fleshAura 2.8s infinite ease-in-out; }
    .flesh-mass { transform-origin: 50px 52px; animation: fleshThrob 2.8s infinite ease-in-out; }
    .mutated-eye { transform-origin: 44px 40px; animation: eyeTwitch 2.1s infinite ease-in-out; }
    .trembling-jaw { transform-origin: 52px 64px; animation: jawTremble 0.22s infinite ease-in-out; }
    .tendril-whip { transform-origin: 22px 58px; animation: tendrilSquirm 1.8s infinite ease-in-out; }
  </style>

  <circle cx="50" cy="50" r="42" fill="#140524" opacity="0.9"/>
  <ellipse cx="50" cy="56" rx="34" ry="26" fill="#2e1065" opacity="0.6"/>

  <!-- Cursed energy halo: pre-blurred by layering, so it costs nothing to pulse. -->
  <g class="flesh-aura">
    <ellipse cx="50" cy="52" rx="39" ry="35" fill="#7c3aed" opacity="0.22"/>
    <ellipse cx="50" cy="52" rx="31" ry="28" fill="#a855f7" opacity="0.18"/>
    <ellipse cx="50" cy="52" rx="23" ry="20" fill="#c084fc" opacity="0.14"/>
  </g>

  <g class="flesh-mass">
    <path class="tendril-whip" d="M22 62 C12 68 8 52 14 44 C18 50 24 54 26 58 Z" fill="#6b21a8" stroke="#a855f7" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M78 64 C88 70 92 56 86 48 C82 54 76 56 74 60 Z" fill="#581c87" stroke="#a855f7" stroke-width="1.6" stroke-linejoin="round"/>

    <path d="M32 78 C20 72 16 54 24 38 C30 24 46 16 62 20 C76 24 86 38 84 56 C82 72 74 84 58 84 C46 84 38 82 32 78 Z" fill="#2d124d" stroke="#c084fc" stroke-width="2.4" stroke-linejoin="round"/>

    <path d="M36 74 C26 68 24 52 30 40 C35 28 48 22 60 25 C70 28 78 38 78 52 C76 64 68 76 54 78 C46 78 40 76 36 74 Z" fill="#e9d5ff" fill-opacity="0.18"/>

    <circle cx="32" cy="34" r="5.5" fill="#3b0764" stroke="#a855f7" stroke-width="1.4"/>
    <circle cx="33" cy="33" r="2" fill="#d8b4e2" opacity="0.7"/>
    <circle cx="68" cy="30" r="4.5" fill="#3b0764" stroke="#a855f7" stroke-width="1.4"/>
    <circle cx="74" cy="42" r="3.5" fill="#4c1d95" stroke="#9333ea" stroke-width="1.2"/>

    <g class="mutated-eye">
      <ellipse cx="44" cy="40" rx="9" ry="12" fill="#090314" stroke="#f43f5e" stroke-width="2.2"/>
      <ellipse cx="44" cy="40" rx="6" ry="8" fill="#e11d48"/>
      <ellipse cx="44" cy="40" rx="2.5" ry="6" fill="#020105"/>
      <circle cx="42" cy="37" r="1.6" fill="#ffffff"/>
      <path d="M44 52 C43 58 41 62 42 68 M47 51 C48 56 46 60 48 65" stroke="#be123c" stroke-width="1.6" stroke-linecap="round"/>
    </g>

    <path d="M24 46 C42 48 58 44 80 50" stroke="#7e22ce" stroke-width="3" stroke-linecap="round"/>
    <path d="M28 41 L30 51 M38 42 L40 52 M54 41 L56 51 M64 42 L66 52 M72 44 L74 54" stroke="#f3e8ff" stroke-width="2" stroke-linecap="round"/>

    <g class="trembling-jaw">
      <path d="M38 65 C46 61 60 61 68 67 C64 76 44 76 38 65 Z" fill="#0c0417" stroke="#7e22ce" stroke-width="2" stroke-linejoin="round"/>
      <polygon points="42,64 44,68 46,64" fill="#faf5ff"/>
      <polygon points="48,63 50,68 52,63" fill="#faf5ff"/>
      <polygon points="54,63 56,68 58,63" fill="#faf5ff"/>
      <polygon points="60,64 62,69 64,65" fill="#faf5ff"/>
      <polygon points="45,73 47,69 49,73" fill="#faf5ff"/>
      <polygon points="53,73 55,68 57,73" fill="#faf5ff"/>
      <polygon points="59,72 61,68 63,72" fill="#faf5ff"/>
      <path d="M47 62 L48 74 M57 62 L58 74" stroke="#c084fc" stroke-width="2" stroke-linecap="round"/>
    </g>

    <path d="M38 78 C38 86 42 88 43 82 M56 82 C56 90 60 92 61 85 M68 76 C68 84 71 85 72 80" stroke="#a855f7" stroke-width="2.2" stroke-linecap="round"/>
  </g>
</svg>`;

let hazardSeq = 0;

/** A face-down card with its empty front. Callers fill `.art`, `.name`, `.kind` and `.badge`. */
export function createCardButton(): HTMLButtonElement {
  hazardSeq += 1;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card';
  button.innerHTML = `
    <span class="inner">
      <span class="face back"><span class="sigil">呪</span></span>
      <span class="face front card-front">
        <span class="art card-art-container card-illustration"></span>
        <span class="badge"></span>
        <span class="foot card-footer-pill card-label-box">
          <span class="name card-name-label"></span>
          <span class="kind card-type-tag"></span>
        </span>
      </span>
    </span>
    <span class="hazard" aria-hidden="true">${hazardArt(hazardSeq)}</span>`;
  return button;
}
