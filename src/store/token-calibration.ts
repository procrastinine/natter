import {
  GLOBAL_TOKEN_CALIBRATION_KEY,
  globalTokenCalibrationFromStored,
} from '../core/token-calibration'
import type { GlobalTokenCalibration } from '../core/types'
import { getSetting } from './settings'
import type { WorkspaceReadAuthority } from './workspace-protocol'

export async function readTokenCalibrationGlobal(
  authority?: WorkspaceReadAuthority,
): Promise<GlobalTokenCalibration> {
  return globalTokenCalibrationFromStored(
    await getSetting<unknown>(GLOBAL_TOKEN_CALIBRATION_KEY, authority),
  )
}
