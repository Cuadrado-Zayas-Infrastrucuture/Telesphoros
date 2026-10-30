/** The landing's two folds, faint behind the one-screen workspace. Decorative and static. The A/C/G/T letters were removed in specs/023 (D7). */
export function BrandBackdrop() {
  return (
    <div className="one-screen-backdrop" aria-hidden="true">
      <svg viewBox="0 0 1440 800" focusable="false" preserveAspectRatio="xMidYMid slice">
        <path className="fold" d="M832-180C632-128 654 58 849 103C1015 142 1066 20 1182 52C1296 84 1185 238 1305 300C1419 359 1574 236 1572 116L1545-142Z" />
        <path className="fold-edge" d="M832-180C632-128 654 58 849 103C1015 142 1066 20 1182 52C1296 84 1185 238 1305 300" />
        <path className="fold" d="M-252 583C-53 346 60 416 86 566C114 725 266 577 348 680C422 774 231 911 90 886L-220 827Z" />
        <path className="fold-edge" d="M-252 583C-53 346 60 416 86 566C114 725 266 577 348 680" />
      </svg>
    </div>
  );
}
