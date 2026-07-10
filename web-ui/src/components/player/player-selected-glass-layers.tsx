import { clsx } from "clsx";
import { PLAYER_SELECTED_GLASS_LAYER_CLASS, PLAYER_SELECTED_TOP_HIGHLIGHT_CLASS } from "./classnames";

interface PlayerSelectedGlassLayersProps {
  visible?: boolean;
}

export function PlayerSelectedGlassLayers({ visible = true }: PlayerSelectedGlassLayersProps) {
  return (
    <>
      <span aria-hidden className={clsx(PLAYER_SELECTED_GLASS_LAYER_CLASS, visible && "opacity-100")} />
      <span aria-hidden className={clsx(PLAYER_SELECTED_TOP_HIGHLIGHT_CLASS, visible && "opacity-100")} />
    </>
  );
}
