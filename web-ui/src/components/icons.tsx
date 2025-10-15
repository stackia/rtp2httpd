import type { JSX, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement>;

function createIcon(paths: (props: { className?: string }) => JSX.Element, viewBox = "0 0 24 24") {
  return function Icon({ className, ...props }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        viewBox={viewBox}
        width={24}
        height={24}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        {...props}
      >
        {paths({ className })}
      </svg>
    );
  };
}

export const SignalIcon = createIcon(() => (
  <>
    <path d="M2.5 12.5a11 11 0 0 1 19 0" />
    <path d="M5.5 12.5a8 8 0 0 1 13 0" />
    <path d="M8.5 12.5a5 5 0 0 1 8 0" />
    <circle cx={12} cy={18} r={1.5} fill="currentColor" stroke="none" />
  </>
));

export const GlobeIcon = createIcon(() => (
  <>
    <circle cx={12} cy={12} r={9} />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18" />
    <path d="M12 3a15 15 0 0 0 0 18" />
  </>
));

export const SunIcon = createIcon(() => (
  <>
    <circle cx={12} cy={12} r={4} />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </>
));

export const MoonIcon = createIcon(() => <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />);

export const UsersIcon = createIcon(() => (
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx={9} cy={7} r={4} />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </>
));

export const ActivityIcon = createIcon(() => <path d="M22 12h-4l-3 9L9 3l-3 9H2" />);

export const LayersIcon = createIcon(() => (
  <>
    <path d="m12 2 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </>
));

export const GaugeIcon = createIcon(() => (
  <>
    <path d="M12 15V9" />
    <path d="M6.34 17.66A8 8 0 1 1 17.66 6.34 8 8 0 0 1 6.34 17.66Z" />
  </>
));

export const LogsIcon = createIcon(() => (
  <>
    <path d="M21 6H3" />
    <path d="M21 12H3" />
    <path d="M21 18H3" />
    <circle cx={7} cy={6} r={1} fill="currentColor" stroke="none" />
    <circle cx={7} cy={12} r={1} fill="currentColor" stroke="none" />
    <circle cx={7} cy={18} r={1} fill="currentColor" stroke="none" />
  </>
));

export const TerminalIcon = createIcon(() => (
  <>
    <path d="m4 17 6-5-6-5" />
    <path d="M12 19h8" />
    <rect x={3} y={3} width={18} height={18} rx={2} ry={2} />
  </>
));

export const ChevronDownIcon = createIcon(() => <path d="m7 10 5 5 5-5" />);
