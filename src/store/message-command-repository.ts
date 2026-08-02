import { TOKEN_CALIBRATION_MODE_KEY, tokenCalibrationModeFromStored } from '../core/global-settings'
import {
  type EditMessageBodyInput,
  type EditMessageBodyResult,
  type EditMessageCalibrationSnapshot,
  editMessageBodyInRepository as editMessageBodyInCoreRepository,
  type MessageEditPreflightReader,
  type MessageMutationRepository,
} from '../core/messages'
import {
  GLOBAL_TOKEN_CALIBRATION_KEY,
  globalTokenCalibrationFromStored,
} from '../core/token-calibration'

export {
  deletePairInRepository,
  deleteSingleMessageInRepository,
  deleteTurnInRepository,
  deleteVariantInRepository,
  mutateMessageBodyInRepository,
  pasteImportInRepository,
} from '../core/messages'

export async function captureEditMessageCalibration(
  reader: Pick<MessageEditPreflightReader, 'getSettings'>,
): Promise<EditMessageCalibrationSnapshot> {
  const rows = await reader.getSettings([GLOBAL_TOKEN_CALIBRATION_KEY, TOKEN_CALIBRATION_MODE_KEY])
  return {
    global: globalTokenCalibrationFromStored(rows.get(GLOBAL_TOKEN_CALIBRATION_KEY)),
    mode: tokenCalibrationModeFromStored(rows.get(TOKEN_CALIBRATION_MODE_KEY)),
  }
}

export function editMessageBodyInRepository(
  repo: MessageMutationRepository,
  input: EditMessageBodyInput,
): Promise<EditMessageBodyResult> {
  return editMessageBodyInCoreRepository(repo, input, captureEditMessageCalibration)
}
