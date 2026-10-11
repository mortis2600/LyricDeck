/** @type {import('@capacitor/cli').CapacitorConfig} */
module.exports = {
  appId: 'com.plexlyrics.app',
  appName: 'Plex Lyrics',
  webDir: 'public',
  server: {
    url: 'http://192.168.0.199:3000',
    cleartext: true
  }
};
