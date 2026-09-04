module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'mite-family',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'mite_family',
        setupExe: 'MiteFamilySetup.exe',
      },
    },
  ],
}
