import { BANDWIDTH_UNITS, type BandwidthUnit } from "../types/ui";
import { usePersistedEnum } from "./use-persisted-enum";

const DEFAULT_UNIT: BandwidthUnit = "bits";

export function useBandwidthUnit(storageKey: string) {
  const [bandwidthUnit, setBandwidthUnit] = usePersistedEnum<BandwidthUnit>(storageKey, DEFAULT_UNIT, BANDWIDTH_UNITS);
  return { bandwidthUnit, setBandwidthUnit };
}
