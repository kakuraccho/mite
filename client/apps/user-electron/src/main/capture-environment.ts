import { release } from 'node:os'
import { wslScreenCaptureErrorCode } from '../shared/screen-capture-error'

export const isWslCaptureEnvironment = (
  platform: string = process.platform,
  kernelRelease: string = release(),
  environment: Record<string, string | undefined> = process.env,
): boolean =>
  platform === 'linux' &&
  (Boolean(environment.WSL_DISTRO_NAME || environment.WSL_INTEROP) ||
    /microsoft|wsl/i.test(kernelRelease))

export const assertScreenCaptureAvailable = () => {
  // WSLg exposes Linux surfaces, not the Windows host desktop. A nonempty
  // thumbnail of its virtual screen can still contain only black pixels.
  if (isWslCaptureEnvironment()) throw new Error(wslScreenCaptureErrorCode)
}
