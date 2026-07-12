import { clsx } from "clsx";
import { EFFECT_CLASS } from "../../lib/design-system";

type PlayerSelectedGlassLayersProps = { compact?: boolean; visible?: boolean };

export function PlayerSelectedGlassLayers({ compact = false, visible = true }: PlayerSelectedGlassLayersProps) {
  const highlightClass = compact ? EFFECT_CLASS.compactSpecular : EFFECT_CLASS.specular;
  return (
    <>
      <span aria-hidden className={clsx(EFFECT_CLASS.selectionTint, visible && "opacity-100")} />
      <span aria-hidden className={clsx(highlightClass, visible && "opacity-100")} />
    </>
  );
}
