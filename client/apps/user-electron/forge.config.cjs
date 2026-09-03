const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')

const copyPackage = (name, buildPath) => {
  const source = path.dirname(require.resolve(name))
  const destination = path.join(buildPath, 'node_modules', ...name.split('/'))
  return new Promise((resolve, reject) => {
    fs.cp(source, destination, { recursive: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

const copyKoffiDependencies = (
  buildPath,
  _electronVersion,
  platform,
  arch,
  callback,
) => {
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) {
    callback(new Error('Invalid Electron package target'))
    return
  }
  Promise.all([
    copyPackage('koffi', buildPath),
    copyPackage(`@koromix/koffi-${platform}-${arch}`, buildPath),
  ]).then(() => callback(), callback)
}

module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/*.node',
    },
    executableName: 'mite-user',
    ignore: [
      /^\/src($|\/)/,
      /^\/index\.html$/,
      /^\/forge\.config\.cjs$/,
      /^\/tsconfig\./,
      /^\/vite\.renderer\.config\.mts$/,
      /^\/\.env/,
    ],
    afterCopy: [copyKoffiDependencies],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'mite_user',
        setupExe: 'MiteUserSetup.exe',
      },
    },
  ],
}
