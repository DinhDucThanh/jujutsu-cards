/**
 * Bespoke emblem per fighter and per synergy half, plus the single table that says which
 * emblem and accent a subject wears. The board, the courtroom and the codex all read from
 * here, so a new minigame that draws cards gets the same art by calling `renderCardIcon`.
 *
 * Every icon is a static string authored here, never user input, so it is safe to inject.
 * The icons use only solid fills and strokes (no gradient `id`s), so several copies can
 * share one document without clashing.
 */
import type { CardSubjectId, TrapId } from '../engine/index.js';

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">';

const ICON_BODY = {
  // Standard pair emblems: one per fighter.
  sukuna: `
    <g fill="none">
    <path d="M20 35 L80 20 M15 60 L85 45 M25 82 L85 68 M35 15 L20 80 M60 15 L45 85" stroke="#7f1d1d" stroke-width="1" opacity="0.45"/>
    <path d="M12 14 C35 32 65 62 88 86 C68 68 32 38 12 14 Z" fill="#f43f5e" stroke="#ffe4e6" stroke-width="1.5"/>
    <path d="M36 12 C56 28 74 46 90 66 C72 50 52 32 36 12 Z" fill="#e11d48" stroke="#fecdd3" stroke-width="1.2"/>
    <path d="M10 38 C28 54 46 72 64 90 C44 74 26 56 10 38 Z" fill="#be123c" stroke="#fda4af" stroke-width="1.2"/>
    <path d="M84 18 C62 42 38 62 16 84 C36 60 60 40 84 18 Z" fill="#ffffff" opacity="0.85"/>
    <circle cx="26" cy="22" r="2" fill="#ffe4e6"/>
    <circle cx="76" cy="72" r="2.5" fill="#f43f5e"/>
    <circle cx="68" cy="28" r="1.8" fill="#fda4af"/>
    </g>`,
  megumi: `
    <g fill="none">
    <path d="M20 86 C14 68 18 52 26 42 M80 86 C86 68 82 52 74 42" stroke="#4f46e5" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
    <path d="M50 82 L32 64 L22 46 L26 14 L42 32 L50 30 L58 32 L74 14 L78 46 L68 64 Z" fill="#0f172a" stroke="#818cf8" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M29 22 L38 34 L27 40 Z M71 22 L62 34 L73 40 Z" fill="#312e81"/>
    <path d="M50 35 V46 M45 39 C47 43 53 43 55 39" stroke="#e0e7ff" stroke-width="2" stroke-linecap="round"/>
    <polygon points="33,47 44,51 36,53" fill="#f43f5e"/>
    <polygon points="67,47 56,51 64,53" fill="#f43f5e"/>
    <path d="M44 52 L50 74 L56 52" stroke="#6366f1" stroke-width="1.8"/>
    <polygon points="46,72 54,72 50,78" fill="#e2e8f0"/>
    <path d="M40 70 L43 76 L46 72 M60 70 L57 76 L54 72" stroke="#f8fafc" stroke-width="1.8" fill="#f8fafc"/>
    </g>`,
  yuji: `
    <g fill="none">
    <path d="M50 8 C64 16 82 26 80 48 C86 58 78 76 66 84 L34 84 C22 76 14 58 20 48 C18 26 36 16 50 8 Z" fill="#0284c7" opacity="0.35"/>
    <path d="M50 14 C60 22 74 30 72 48 C76 56 70 70 62 78 L38 78 C30 70 24 56 28 48 C26 30 40 22 50 14 Z" stroke="#38bdf8" stroke-width="2.5" fill="#0369a1" fill-opacity="0.4"/>
    <path d="M33 52 L67 52 L69 68 C69 75 63 80 56 80 L56 88 L44 88 L44 80 C37 80 31 75 31 68 Z" fill="#e0f2fe" stroke="#0284c7" stroke-width="2.5" stroke-linejoin="round"/>
    <rect x="29" y="34" width="11" height="22" rx="4" fill="#f0f9ff" stroke="#0369a1" stroke-width="2.2"/>
    <rect x="40" y="31" width="11" height="24" rx="4" fill="#f0f9ff" stroke="#0369a1" stroke-width="2.2"/>
    <rect x="51" y="33" width="11" height="23" rx="4" fill="#f0f9ff" stroke="#0369a1" stroke-width="2.2"/>
    <rect x="62" y="37" width="10" height="20" rx="4" fill="#f0f9ff" stroke="#0369a1" stroke-width="2.2"/>
    <path d="M29 48 L56 48 C60 48 62 52 60 56 C58 59 54 60 48 60 L33 60 C28 60 26 53 29 48 Z" fill="#bae6fd" stroke="#0369a1" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M32 41 H37 M43 39 H48 M54 40 H59 M65 43 H69" stroke="#0284c7" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M22 30 L30 22 M78 30 L70 22 M50 6 L50 18" stroke="#7dd3fc" stroke-width="2.5" stroke-linecap="round"/>
    </g>`,
  mahito: `
    <g fill="none" stroke-linejoin="round" stroke-linecap="round">
    <circle cx="50" cy="50" r="42" fill="#1e0b36" opacity="0.85"/>
    <circle cx="50" cy="50" r="32" fill="#0f0720" stroke="#a855f7" stroke-width="2.6"/>
    <ellipse cx="40" cy="42" rx="5.5" ry="7.5" fill="#2e1065" stroke="#7c3aed" stroke-width="1.8"/>
    <ellipse cx="60" cy="42" rx="6.5" ry="8.5" fill="#18042b" stroke="#c084fc" stroke-width="2"/>
    <circle cx="60" cy="42" r="3.2" fill="#f43f5e"/>
    <circle cx="61.5" cy="40.5" r="1.2" fill="#ffffff"/>
    <path d="M26 44 C44 46 56 44 74 47" stroke="#c084fc" stroke-width="2.2"/>
    <path d="M33 40 L35 48 M42 40 L44 48 M52 40 L54 48 M62 41 L64 49 M68 41 L70 49" stroke="#e9d5ff" stroke-width="2"/>
    <path d="M38 65 C46 68 54 68 62 64" stroke="#581c87" stroke-width="3.2"/>
    <path d="M42 62 V68 M48 63 V69 M54 63 V69 M58 62 V67" stroke="#a855f7" stroke-width="2"/>
    <path d="M68 67 C68 74 71 76 72 71" stroke="#9333ea" stroke-width="2"/>
    </g>`,
  todo: `
    <g fill="none">
    <circle cx="50" cy="48" r="36" stroke="#d946ef" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.5"/>
    <circle cx="50" cy="48" r="26" stroke="#38bdf8" stroke-width="2" opacity="0.7"/>
    <path d="M50 14 L53 34 L70 22 L57 39 L78 44 L57 49 L70 66 L52 54 L50 74 L48 54 L30 66 L43 49 L22 44 L43 39 L30 22 L47 34 Z" fill="#f0abfc" opacity="0.35"/>
    <path d="M14 78 L26 62 L23 46 C22 41 26 39 29 43 L32 49 L35 30 C36 25 41 25 41 30 L40 45 L43 26 C44 21 49 22 48 27 L46 45 L49 30 C50 26 54 27 53 32 L49 56 C48 64 42 68 35 70 L24 84 Z" fill="#f5d0fe" stroke="#a21caf" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M86 78 L74 62 L77 46 C78 41 74 39 71 43 L68 49 L65 30 C64 25 59 25 59 30 L60 45 L57 26 C56 21 51 22 52 27 L54 45 L51 30 C50 26 46 27 47 32 L51 56 C52 64 58 68 65 70 L76 84 Z" fill="#fae8ff" stroke="#86198f" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M50 18 L50 72 M36 32 L64 60 M64 32 L36 60" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
    </g>`,
  jogo: `
    <g fill="none" stroke-linejoin="round" stroke-linecap="round">
    <circle cx="50" cy="50" r="40" fill="#1c0a04" opacity="0.9"/>
    <path d="M50 36 C36 42 22 66 8 88 H92 C78 66 64 42 50 36 Z" fill="#44403c" stroke="#0a0a0a" stroke-width="3"/>
    <path d="M26 88 C34 72 40 56 42 46 M74 88 C66 72 60 56 58 46" stroke="#57534e" stroke-width="2"/>
    <path d="M46 40 C40 52 36 66 32 88" stroke="#0a0a0a" stroke-width="8"/>
    <path d="M54 40 C60 52 64 66 68 88" stroke="#0a0a0a" stroke-width="8"/>
    <path d="M46 40 C40 52 36 66 32 88" stroke="#f97316" stroke-width="4.5"/>
    <path d="M54 40 C60 52 64 66 68 88" stroke="#f97316" stroke-width="4.5"/>
    <path d="M50 40 L46 56 L52 68 L48 88" stroke="#0a0a0a" stroke-width="6"/>
    <path d="M50 40 L46 56 L52 68 L48 88" stroke="#fde047" stroke-width="2.4"/>
    <ellipse cx="50" cy="36" rx="11" ry="4" fill="#7f1d1d" stroke="#0a0a0a" stroke-width="2"/>
    <path d="M28 32 C16 28 16 14 26 12 C26 2 42 0 46 8 C52 2 68 2 70 10 C82 12 84 28 72 32 Z" fill="#71717a" stroke="#0a0a0a" stroke-width="2.5"/>
    <path d="M40 36 C38 24 44 16 50 12 C56 16 62 24 60 36 Z" fill="#f97316" stroke="#0a0a0a" stroke-width="2"/>
    <path d="M46 36 C46 28 49 24 50 21 C52 25 54 30 54 36 Z" fill="#fde047"/>
    <circle cx="16" cy="46" r="2.2" fill="#fbbf24"/>
    <circle cx="84" cy="44" r="2.4" fill="#f97316"/>
    <circle cx="80" cy="14" r="1.8" fill="#fef08a"/>
    </g>`,
  hakari: `
    <g fill="none">
    <circle cx="50" cy="50" r="38" fill="#062e1b" opacity="0.75"/>
    <rect x="22" y="18" width="50" height="64" rx="8" fill="#061a10" stroke="#0a0a0a" stroke-width="7"/>
    <rect x="22" y="18" width="50" height="64" rx="8" fill="#061a10" stroke="#f59e0b" stroke-width="3"/>
    <rect x="27" y="24" width="38" height="30" rx="4" fill="#022c14" stroke="#10b981" stroke-width="1.8"/>
    <rect x="30" y="27" width="32" height="8" rx="2" fill="#065f46"/>
    <text x="46" y="33" text-anchor="middle" fill="#34d399" font-family="sans-serif" font-weight="900" font-size="4.8">JACKPOT</text>
    <rect x="30" y="38" width="9" height="12" rx="2" fill="#ffffff"/>
    <text x="34.5" y="47" text-anchor="middle" fill="#dc2626" font-family="serif" font-weight="900" font-size="9">7</text>
    <rect x="41.5" y="38" width="9" height="12" rx="2" fill="#ffffff"/>
    <text x="46" y="47" text-anchor="middle" fill="#dc2626" font-family="serif" font-weight="900" font-size="9">7</text>
    <rect x="53" y="38" width="9" height="12" rx="2" fill="#ffffff"/>
    <text x="57.5" y="47" text-anchor="middle" fill="#dc2626" font-family="serif" font-weight="900" font-size="9">7</text>
    <path d="M72 30 H75 V62 H72 Z" fill="#94a3b8"/>
    <circle cx="73.5" cy="25" r="5.5" fill="#ef4444" stroke="#fecaca" stroke-width="1.2"/>
    <path d="M72 45 H62" stroke="#64748b" stroke-width="2.2" stroke-linecap="round"/>
    </g>`,
  gojo: `
    <rect x="2" y="2" width="96" height="96" rx="8" fill="#020617"/>
    <circle cx="50" cy="50" r="46" fill="#0ea5e9" opacity="0.12"/>
    <path d="M50 50C36 28 10 30 10 50C10 70 36 72 50 50C64 28 90 30 90 50C90 70 64 72 50 50Z" fill="none" stroke="#0284c7" stroke-width="11" stroke-linecap="round" opacity="0.4"/>
    <path d="M50 50C36 28 10 30 10 50C10 70 36 72 50 50C64 28 90 30 90 50C90 70 64 72 50 50Z" fill="none" stroke="#7dd3fc" stroke-width="5" stroke-linecap="round" opacity="0.8"/>
    <path d="M50 50C36 28 10 30 10 50C10 70 36 72 50 50C64 28 90 30 90 50C90 70 64 72 50 50Z" fill="none" stroke="#f0f9ff" stroke-width="1.8" stroke-linecap="round"/>
    <g fill="#e0f2fe"><circle cx="20" cy="22" r="1.2"/><circle cx="84" cy="18" r="1.2"/><circle cx="30" cy="84" r="1.2"/><circle cx="78" cy="82" r="1.2"/><circle cx="50" cy="12" r="1"/><circle cx="50" cy="90" r="1"/><circle cx="6" cy="64" r="1"/><circle cx="94" cy="36" r="1"/></g>`,
  higuruma: `
    <g fill="none">
    <path d="M50 16 V26 M38 21 H62 M38 21 L34 29 H42 Z M62 21 L58 29 H66 Z" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M22 72 H78 L82 82 H18 Z" fill="#78350f" stroke="#fbbf24" stroke-width="2" stroke-linejoin="round"/>
    <rect x="25" y="66" width="50" height="7" rx="2" fill="#92400e" stroke="#fbbf24" stroke-width="1.8"/>
    <g transform="rotate(-32 50 50)">
      <rect x="42" y="44" width="28" height="11" rx="3" fill="#b45309" stroke="#f59e0b" stroke-width="2"/>
      <rect x="46" y="44" width="4" height="11" fill="#fbbf24"/>
      <rect x="62" y="44" width="4" height="11" fill="#fbbf24"/>
      <path d="M30 48 L44 49.5" stroke="#78350f" stroke-width="6" stroke-linecap="round"/>
      <path d="M30 48 L44 49.5" stroke="#fbbf24" stroke-width="1.5" stroke-linecap="round"/>
    </g>
    <ellipse cx="50" cy="85" rx="32" ry="4" stroke="#fbbf24" stroke-width="1.5" opacity="0.7"/>
    </g>`,
  nobara: `
    <rect x="2" y="2" width="96" height="96" rx="8" fill="#1f0a10"/>
    <circle cx="50" cy="50" r="34" fill="none" stroke="#fb7185" stroke-width="1.5" opacity="0.4" stroke-dasharray="4 5"/>
    <g transform="rotate(-45 50 50)">
      <rect x="46" y="16" width="8" height="52" fill="#94a3b8"/>
      <path d="M46 68L50 84L54 68Z" fill="#cbd5e1"/>
      <rect x="40" y="10" width="20" height="8" rx="2" fill="#e2e8f0" stroke="#475569"/>
    </g>
    <path d="M18 30L30 42M80 22L70 34M22 78L34 68M82 74L72 64" stroke="#e11d48" stroke-width="2.5" stroke-linecap="round"/>
    <g fill="#fda4af"><circle cx="14" cy="50" r="1.6"/><circle cx="86" cy="50" r="1.6"/><circle cx="50" cy="10" r="1.6"/><circle cx="50" cy="90" r="1.6"/></g>`,
  nanami: `
    <rect x="2" y="2" width="96" height="96" rx="8" fill="#1c1917"/>
    <path d="M40 14L60 14L64 30L36 30Z" fill="#eab308" stroke="#713f12" stroke-width="1.5"/>
    <path d="M36 30L64 30L72 90L50 98L28 90Z" fill="#facc15" stroke="#713f12" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M48 32L52 92" stroke="#fef08a" stroke-width="2" opacity="0.5"/>
    <g fill="#0a0a0a"><circle cx="44" cy="40" r="2.4"/><circle cx="56" cy="40" r="2.4"/><circle cx="50" cy="50" r="2.4"/><circle cx="42" cy="58" r="2.4"/><circle cx="58" cy="58" r="2.4"/><circle cx="50" cy="68" r="2.4"/><circle cx="40" cy="78" r="2.4"/><circle cx="60" cy="78" r="2.4"/><circle cx="50" cy="88" r="2.4"/></g>`,

  // Synergy half emblems: one per synergy card.
  synergy_todo_rock: `
    <rect x="2" y="2" width="96" height="96" rx="8" fill="#1c1917"/>
    <circle cx="50" cy="50" r="42" fill="none" stroke="#d946ef" stroke-width="3" stroke-dasharray="20 8" opacity="0.55"/>
    <path d="M28 42L46 26L72 32L80 54L64 76L36 72L22 58Z" fill="#78716c" stroke="#d6d3d1" stroke-width="2" stroke-linejoin="round"/>
    <path d="M46 26L50 48L36 72M50 48L80 54M50 48L72 32" stroke="#44403c" stroke-width="2" fill="none"/>
    <path d="M4 30H24M2 50H22M6 70H26" stroke="#e879f9" stroke-width="3" stroke-linecap="round"/>
    <path d="M76 10L60 20" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M30 88Q50 96 70 88" stroke="#c084fc" stroke-width="2" fill="none" opacity="0.6"/>`,
  synergy_yuji_blackflash: `
    <g fill="none">
    <circle cx="50" cy="52" r="34" fill="#050204" stroke="#be123c" stroke-width="2" stroke-dasharray="8 4"/>
    <path d="M50 50 L28 24 L36 18 L14 8" stroke="#f43f5e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M50 50 L28 24 L36 18 L14 8" stroke="#000000" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M50 50 L74 22 L66 16 L88 6" stroke="#f43f5e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M50 50 L74 22 L66 16 L88 6" stroke="#000000" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M50 50 L18 58 L24 68 L8 82" stroke="#f43f5e" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M50 50 L82 60 L74 70 L92 84" stroke="#f43f5e" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M33 52 L67 52 L69 68 C69 75 63 80 56 80 L56 88 L44 88 L44 80 C37 80 31 75 31 68 Z" fill="#18090f" stroke="#f43f5e" stroke-width="2.4"/>
    <rect x="29" y="34" width="11" height="22" rx="4" fill="#090406" stroke="#f43f5e" stroke-width="2.2"/>
    <rect x="40" y="31" width="11" height="24" rx="4" fill="#090406" stroke="#f43f5e" stroke-width="2.2"/>
    <rect x="51" y="33" width="11" height="23" rx="4" fill="#090406" stroke="#f43f5e" stroke-width="2.2"/>
    <rect x="62" y="37" width="10" height="20" rx="4" fill="#090406" stroke="#f43f5e" stroke-width="2.2"/>
    <path d="M29 48 L56 48 C60 48 62 52 60 56 C58 59 54 60 48 60 L33 60 C28 60 26 53 29 48 Z" fill="#1f0812" stroke="#fb7185" stroke-width="2.4"/>
    <circle cx="50" cy="44" r="7" fill="#000000" stroke="#f43f5e" stroke-width="2.5"/>
    </g>`,
  synergy_nanami_blade: `
    <g fill="none">
    <g transform="rotate(-28 50 50)">
      <rect x="64" y="44" width="26" height="12" rx="4" fill="#78350f" stroke="#451a03" stroke-width="2"/>
      <circle cx="72" cy="50" r="2" fill="#fde68a"/>
      <circle cx="82" cy="50" r="2" fill="#fde68a"/>
      <rect x="60" y="41" width="5" height="18" rx="1.5" fill="#d97706" stroke="#78350f" stroke-width="1.5"/>
      <path d="M10 36 L60 42 L60 58 L14 62 Z" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2" stroke-linejoin="round"/>
      <path d="M20 37 L16 61 M30 38 L26 61 M40 39 L36 60 M50 41 L46 59 M14 48 L60 51" stroke="#94a3b8" stroke-width="1.4"/>
      <circle cx="17" cy="43" r="2.6" fill="#0f172a"/>
      <circle cx="24" cy="54" r="2.8" fill="#0f172a"/>
      <circle cx="27" cy="43" r="2.4" fill="#0f172a"/>
      <circle cx="34" cy="51" r="2.8" fill="#0f172a"/>
      <circle cx="38" cy="42" r="2.5" fill="#0f172a"/>
      <circle cx="44" cy="55" r="2.7" fill="#0f172a"/>
      <circle cx="48" cy="45" r="2.6" fill="#0f172a"/>
      <circle cx="55" cy="52" r="2.5" fill="#0f172a"/>
      <circle cx="18" cy="56" r="2.2" fill="#0f172a"/>
    </g>
    </g>`,
  synergy_nanami_ratio: `
    <g fill="none">
    <text x="50" y="30" text-anchor="middle" fill="#fbbf24" font-family="serif" font-weight="900" font-size="24" letter-spacing="2">7 : 3</text>
    <path d="M14 42 V38 H63 V42" stroke="#fbbf24" stroke-width="1.8"/>
    <path d="M65 42 V38 H86 V42" stroke="#f43f5e" stroke-width="1.8"/>
    <g stroke="#09090b" stroke-width="1.2">
      <rect x="14" y="48" width="7" height="12" fill="#f59e0b"/>
      <rect x="21" y="48" width="7" height="12" fill="#f59e0b"/>
      <rect x="28" y="48" width="7" height="12" fill="#f59e0b"/>
      <rect x="35" y="48" width="7" height="12" fill="#f59e0b"/>
      <rect x="42" y="48" width="7" height="12" fill="#f59e0b"/>
      <rect x="49" y="48" width="7" height="12" fill="#f59e0b"/>
      <rect x="56" y="48" width="7" height="12" fill="#fbbf24"/>
      <rect x="63" y="48" width="7.5" height="12" fill="#e11d48"/>
      <rect x="70.5" y="48" width="7.5" height="12" fill="#be123c"/>
      <rect x="78" y="48" width="8" height="12" fill="#9f1239"/>
    </g>
    <line x1="63" y1="34" x2="63" y2="82" stroke="#f43f5e" stroke-width="2" stroke-dasharray="3 2"/>
    <circle cx="63" cy="54" r="14" stroke="#f43f5e" stroke-width="2.5"/>
    <circle cx="63" cy="54" r="6" fill="#f43f5e" fill-opacity="0.3" stroke="#fecdd3" stroke-width="1.8"/>
    <path d="M55 46 L48 39 M71 62 L78 69 M71 46 L78 39 M55 62 L48 69" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
    </g>`,
  synergy_gojo_blindfold: `
    <g fill="none">
    <circle cx="50" cy="54" r="36" fill="#0284c7" opacity="0.22"/>
    <path d="M18 44 L12 28 L25 33 L22 14 L36 26 L42 8 L50 24 L58 8 L64 26 L78 14 L75 33 L88 28 L82 44 Z" fill="#f8fafc" stroke="#94a3b8" stroke-width="2" stroke-linejoin="round"/>
    <path d="M36 26 L40 38 M50 24 L50 38 M64 26 L60 38" stroke="#cbd5e1" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M14 42 C36 49 64 49 86 42 L84 68 C62 76 38 76 16 68 Z" fill="#090d16" stroke="#475569" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M22 49 C42 55 58 55 78 49" stroke="#334155" stroke-width="2" stroke-linecap="round"/>
    <path d="M20 61 C40 67 60 67 80 61" stroke="#334155" stroke-width="2" stroke-linecap="round"/>
    <path d="M28 46 L24 66 M72 46 L76 66" stroke="#1e293b" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M22 70 C36 75 64 75 78 70" stroke="#38bdf8" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="34" cy="70" rx="8" ry="2.5" fill="#e0f2fe"/>
    <ellipse cx="66" cy="70" rx="8" ry="2.5" fill="#e0f2fe"/>
    </g>`,
  synergy_gojo_sixeyes: `
    <g fill="none">
    <ellipse cx="29" cy="52" rx="20" ry="11" fill="#0284c7" opacity="0.35"/>
    <ellipse cx="71" cy="52" rx="20" ry="11" fill="#0284c7" opacity="0.35"/>
    <path d="M9 53 C15 43 27 42 44 52 C35 60 20 60 9 53 Z" fill="#f0f9ff" stroke="#bae6fd" stroke-width="1.5"/>
    <path d="M91 53 C85 43 73 42 56 52 C65 60 80 60 91 53 Z" fill="#f0f9ff" stroke="#bae6fd" stroke-width="1.5"/>
    <circle cx="28" cy="51.5" r="7.5" fill="#0369a1"/>
    <circle cx="28" cy="51.5" r="5.5" fill="#38bdf8"/>
    <circle cx="28" cy="51.5" r="3.5" stroke="#e0f2fe" stroke-width="1" stroke-dasharray="2 1.5"/>
    <circle cx="28" cy="51.5" r="1.8" fill="#ffffff"/>
    <circle cx="25.5" cy="49" r="1.5" fill="#ffffff"/>
    <circle cx="72" cy="51.5" r="7.5" fill="#0369a1"/>
    <circle cx="72" cy="51.5" r="5.5" fill="#38bdf8"/>
    <circle cx="72" cy="51.5" r="3.5" stroke="#e0f2fe" stroke-width="1" stroke-dasharray="2 1.5"/>
    <circle cx="72" cy="51.5" r="1.8" fill="#ffffff"/>
    <circle cx="69.5" cy="49" r="1.5" fill="#ffffff"/>
    <path d="M6 53 C14 40 28 40 45 51 L43 48 C29 38 15 38 4 49 Z" fill="#ffffff"/>
    <path d="M94 53 C86 40 72 40 55 51 L57 48 C71 38 85 38 96 49 Z" fill="#ffffff"/>
    <path d="M12 46 L5 41 M20 43 L16 37 M30 43 L29 38" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M88 46 L95 41 M80 43 L84 37 M70 43 L71 38" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M10 35 C20 31 32 34 44 41" stroke="#e2e8f0" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M90 35 C80 31 68 34 56 41" stroke="#e2e8f0" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M48 46 L50 56 L52 46" stroke="#38bdf8" stroke-width="1.2" opacity="0.6"/>
    <path d="M28 44 C26 32 32 24 29 14 M72 44 C74 32 68 24 71 14" stroke="#7dd3fc" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="4 3"/>
    </g>`,
  synergy_megumi_handsign: `
    <g fill="none">
    <path d="M22 78 L28 42 L34 12 L46 32 L54 14 L60 36 L88 44 L72 56 L84 64 L56 68 L48 84 Z" fill="#090d16" stroke="#6366f1" stroke-width="1.8" opacity="0.85"/>
    <path d="M56 42 L66 40 L60 46 Z" fill="#f43f5e"/>
    <path d="M18 84 L28 62 L34 26 C35 22 40 22 41 27 L43 44 L48 24 C49 20 54 21 54 26 L53 45 L80 48 C85 49 85 55 79 56 L56 58 L72 64 C76 66 75 71 70 70 L46 66 L36 86 Z" fill="#e2e8f0" stroke="#334155" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M42 46 L54 47 M45 54 L64 53 M36 62 L48 62" stroke="#475569" stroke-width="1.8" stroke-linecap="round"/>
    </g>`,
  synergy_megumi_dog: `
    <rect x="2" y="2" width="96" height="96" rx="8" fill="#070a14"/>
    <path d="M18 26L36 40L50 34L64 40L82 26L84 62Q76 88 50 92Q24 88 16 62Z" fill="#111827" stroke="#e2e8f0" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M36 56Q50 48 64 56Q60 74 50 78Q40 74 36 56Z" fill="#e2e8f0" opacity="0.9"/>
    <path d="M26 50Q36 44 44 54Q36 58 26 50Z M74 50Q64 44 56 54Q64 58 74 50Z" fill="#f97316"/>
    <g fill="#7f1d1d"><circle cx="36" cy="51" r="1.2"/><circle cx="64" cy="51" r="1.2"/></g>
    <path d="M46 60H54L50 66Z" fill="#0f172a"/>
    <path d="M40 76L43 88L46 76M54 76L57 88L60 76" fill="#f8fafc" stroke="#e2e8f0" stroke-width="0.8"/>
    <path d="M50 22L50 34M44 26Q50 22 56 26" stroke="#facc15" stroke-width="2" fill="none" stroke-linecap="round"/>`,

  // Bespoke trap emblem: the cursed object that sits on the Finger card.
  cursed_finger: `
    <g fill="none">
    <path d="M26 78 C16 58 24 38 30 22 M76 74 C86 54 74 34 68 18" stroke="#e11d48" stroke-width="2.2" stroke-linecap="round" opacity="0.65"/>
    <circle cx="50" cy="48" r="34" fill="#4c0519" opacity="0.35"/>
    <g transform="rotate(-26 50 52)">
    <path d="M41 86 L40 68 C38 63 39 58 41 54 L41 42 C39 38 40 33 43 29 L45 19 C47 15 53 15 55 19 L57 29 C60 33 61 38 59 42 L59 54 C61 58 62 63 60 68 L59 86 Z" fill="#5c1022" stroke="#fda4af" stroke-width="2" stroke-linejoin="round"/>
    <path d="M43 32 Q50 29 57 32 M44 35 Q50 33 56 35 M42 52 Q50 49 58 52 M43 56 Q50 54 57 56" stroke="#1f040a" stroke-width="2" stroke-linecap="round"/>
    <path d="M46 22 V78" stroke="#881337" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
    <path d="M45 21 C45 12 48 4 53 2 C54 8 56 14 55 21 C52 23 48 23 45 21 Z" fill="#090406" stroke="#f43f5e" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M49 18 C49 12 51 7 53 4" stroke="#ffe4e6" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M36 64 L64 60 L65 72 L37 76 Z" fill="#fef3c7" stroke="#92400e" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M35 73 L63 69 L62 81 L34 85 Z" fill="#fde68a" stroke="#78350f" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M44 67 H56 M50 64 V72 M43 77 H55" stroke="#be123c" stroke-width="2" stroke-linecap="round"/>
    </g>
    </g>`,
} as const;

export type CardIconKey = keyof typeof ICON_BODY;

const CARD_ICON_KEYS = Object.keys(ICON_BODY) as readonly CardIconKey[];

/** Every icon key, in registry order. Used by tests and by any minigame that lists icons. */
export function cardIconKeys(): readonly CardIconKey[] {
  return CARD_ICON_KEYS;
}

export function isCardIconKey(key: string): key is CardIconKey {
  return Object.prototype.hasOwnProperty.call(ICON_BODY, key);
}

/** The inline SVG markup for an icon key, or '' for an unknown key so a typo draws nothing. */
export function renderCardIcon(cardKey: string): string {
  if (!isCardIconKey(cardKey)) return '';
  return `${SVG_OPEN}${ICON_BODY[cardKey]}</svg>`;
}

export interface CardVisualConfig {
  /** Emblem on the subject's standard pair card, or null when it only appears in a synergy. */
  readonly pairIcon: CardIconKey | null;
  /** Emblem on the subject's synergy card, or null when it has none. */
  readonly synergyIcon: CardIconKey | null;
  /** Border colour of the subject's pair palette. The courtroom badges wear it too. */
  readonly accent: string;
}

/**
 * Single source of truth for each subject's emblem and accent. The per-character colours
 * in the stylesheet are keyed by the same subject ids, so a new fighter needs an entry here
 * and a palette rule there.
 */
export const CARD_VISUALS: Readonly<Record<CardSubjectId, CardVisualConfig>> = {
  satoru_gojo: { pairIcon: 'gojo', synergyIcon: 'synergy_gojo_blindfold', accent: '#22d3ee' },
  sukuna: { pairIcon: 'sukuna', synergyIcon: null, accent: '#ef4444' },
  mahito: { pairIcon: 'mahito', synergyIcon: null, accent: '#7c3aed' },
  kento_nanami: { pairIcon: 'nanami', synergyIcon: 'synergy_nanami_blade', accent: '#fbbf24' },
  nobara_kugisaki: { pairIcon: 'nobara', synergyIcon: null, accent: '#fb923c' },
  yuji_itadori: { pairIcon: 'yuji', synergyIcon: 'synergy_yuji_blackflash', accent: '#7dd3fc' },
  aoi_todo: { pairIcon: 'todo', synergyIcon: 'synergy_todo_rock', accent: '#e879f9' },
  jogo: { pairIcon: 'jogo', synergyIcon: null, accent: '#f97316' },
  megumi_fushiguro: { pairIcon: 'megumi', synergyIcon: 'synergy_megumi_handsign', accent: '#818cf8' },
  kinji_hakari: { pairIcon: 'hakari', synergyIcon: null, accent: '#2dd4bf' },
  higuruma: { pairIcon: 'higuruma', synergyIcon: null, accent: '#d97706' },
  divine_dog: { pairIcon: null, synergyIcon: 'synergy_megumi_dog', accent: '#94a3b8' },
  ratio_blade: { pairIcon: null, synergyIcon: 'synergy_nanami_ratio', accent: '#facc15' },
  six_eyes: { pairIcon: null, synergyIcon: 'synergy_gojo_sixeyes', accent: '#67e8f9' },
};

/** The emblem a trap card wears once it is face-up, keyed by the trap it is. */
export const TRAP_ICON: Readonly<Record<TrapId, CardIconKey>> = {
  sukuna_finger: 'cursed_finger',
};

/**
 * The emblem a card wears. A synergy card uses its synergy half when it has one. Otherwise the
 * pair emblem, falling back to the synergy emblem for subjects that only exist in a synergy.
 */
export function cardIconFor(subject: CardSubjectId, synergy: boolean): CardIconKey | null {
  const visual = CARD_VISUALS[subject];
  if (synergy && visual.synergyIcon !== null) return visual.synergyIcon;
  return visual.pairIcon ?? visual.synergyIcon;
}
