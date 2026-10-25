const sequences = ['ACGTTCAG', 'TGCAAGTC', 'GATCTGCA', 'CTAGACTG', 'AGTCGTAC', 'TGCATCGA'];

/**
 * Code-drawn hero texture: two soft folds and an A/C/G/T sequence, ported from the public Telesphoros site's
 * "Product first" hero. Original shapes only (no raster artwork), hidden from assistive technology, never
 * interactive and static. Every colour comes from a stylesheet token (landing.css), none from this file.
 */
export function HeroBackdrop() {
  return (
    <div className="landing-backdrop" aria-hidden="true">
      <svg className="landing-backdrop-folds" viewBox="0 0 1440 800" focusable="false" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="landing-fold-light" x1="0%" y1="0%" x2="85%" y2="100%">
            <stop className="landing-fold-stop-dark" offset="0" />
            <stop className="landing-fold-stop-light" offset="0.44" />
            <stop className="landing-fold-stop-mid" offset="0.59" />
            <stop className="landing-fold-stop-dark" offset="1" />
          </linearGradient>
          <linearGradient id="landing-fold-dark" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop className="landing-fold-stop-dark" offset="0" />
            <stop className="landing-fold-stop-mid" offset="0.5" />
            <stop className="landing-fold-stop-dark" offset="1" />
          </linearGradient>
        </defs>
        <path fill="url(#landing-fold-light)" d="M832-180C632-128 654 58 849 103C1015 142 1066 20 1182 52C1296 84 1185 238 1305 300C1419 359 1574 236 1572 116L1545-142Z" />
        <path className="landing-fold-edge" d="M832-180C632-128 654 58 849 103C1015 142 1066 20 1182 52C1296 84 1185 238 1305 300" />
        <path fill="url(#landing-fold-dark)" d="M-252 583C-53 346 60 416 86 566C114 725 266 577 348 680C422 774 231 911 90 886L-220 827Z" />
        <path className="landing-fold-edge" d="M-252 583C-53 346 60 416 86 566C114 725 266 577 348 680" />
      </svg>
      <svg className="landing-backdrop-sequence" viewBox="0 0 800 650" focusable="false">
        {sequences.map((row, index) => (
          <g key={row}>
            <path d={`M24 ${80 + index * 92}H780`} />
            {row.split('').map((base, column) => (
              <text key={column} x={40 + column * 100} y={62 + index * 92}>
                {base}
              </text>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}
