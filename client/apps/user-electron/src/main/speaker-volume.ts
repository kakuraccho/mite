import { execFile } from 'node:child_process'
import path from 'node:path'

export interface SpeakerVolume {
  getLevel(): Promise<number>
  setLevel(level: number): Promise<void>
}

export async function ensureMinimumSpeakerVolume(volume: SpeakerVolume) {
  const current = await volume.getLevel()
  if (!Number.isFinite(current) || current < 0 || current > 1) {
    throw new Error('Speaker volume is invalid')
  }
  if (current < 0.5) await volume.setLevel(0.5)
}

// Windows Core Audio COM declarations. Run in the OS-provided PowerShell
// process so Electron does not depend on a COM runtime or a new native package.
export const coreAudioTypeDefinition = `
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MiteDeviceEnumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMiteDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMiteDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMiteDevice {
  [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMiteEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
  [PreserveSig] int GetMasterVolumeLevel(out float level);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
}
public static class MiteSpeakerVolume {
  public static float Access(bool set, float level) {
    object enumerator = null, endpoint = null;
    IMiteDevice device = null;
    try {
      enumerator = new MiteDeviceEnumerator();
      // eRender, eConsole: the default output used by browser audio.
      Marshal.ThrowExceptionForHR(((IMiteDeviceEnumerator)enumerator).GetDefaultAudioEndpoint(0, 0, out device));
      Guid iid = typeof(IMiteEndpointVolume).GUID;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
      var volume = (IMiteEndpointVolume)endpoint;
      if (set) {
        Guid context = Guid.Empty;
        Marshal.ThrowExceptionForHR(volume.SetMasterVolumeLevelScalar(level, ref context));
      }
      float current;
      Marshal.ThrowExceptionForHR(volume.GetMasterVolumeLevelScalar(out current));
      return current;
    } finally {
      if (endpoint != null) Marshal.ReleaseComObject(endpoint);
      if (device != null) Marshal.ReleaseComObject(device);
      if (enumerator != null) Marshal.ReleaseComObject(enumerator);
    }
  }
}
`

async function accessWindowsVolume(set: boolean, level = 0): Promise<number> {
  if (!Number.isFinite(level) || level < 0 || level > 1)
    throw new Error('Invalid volume')
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${coreAudioTypeDefinition}
'@
[MiteSpeakerVolume]::Access($${set ? 'true' : 'false'}, [float]${level}).ToString([Globalization.CultureInfo]::InvariantCulture)
`
  const executable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error)
          reject(new Error('Windows speaker volume could not be adjusted'))
        else resolve(stdout)
      },
    )
  })
  return Number(output.trim())
}

export async function prepareSpeakerVolume() {
  if (process.platform !== 'win32') return
  await ensureMinimumSpeakerVolume({
    getLevel: () => accessWindowsVolume(false),
    setLevel: async (level) => {
      await accessWindowsVolume(true, level)
    },
  })
}
