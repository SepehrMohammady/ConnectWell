// electron-builder configuration for the Windows installer.
//
// apps/build.mjs sets the CW_* variables from your instance file, so the
// installer carries your server's name and identity. Without them this makes a
// generic build that asks for a server address on first start.
const env = process.env;

const name = env.CW_NAME || 'ConnectWell';

module.exports = {
    // Also the AppUserModelID Windows files notifications under — main.js reads
    // the same value from app-config.json, and the two must match.
    appId: env.CW_APP_ID || 'app.connectwell.desktop',
    productName: name,
    executableName: 'ConnectWell',
    directories: { output: env.CW_OUT_DIR || 'dist', buildResources: 'build' },
    files: ['main.js', 'preload.js', 'strings.js', 'pages/**', 'assets/**', 'app-config.json', 'package.json'],
    // Windows reads toast images from disk, and cannot see into app.asar.
    asarUnpack: ['assets/**'],
    extraMetadata: env.CW_VERSION ? { version: env.CW_VERSION } : undefined,
    win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        icon: 'build/icon.png',
        artifactName: 'ConnectWell-Setup-${version}.${ext}',
    },
    nsis: {
        // Per-user, no administrator rights needed, and an uninstall that keeps
        // the sign-in so a reinstall does not log anybody out.
        oneClick: true,
        perMachine: false,
        deleteAppDataOnUninstall: false,
        shortcutName: name,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        runAfterFinish: true,
    },
};
