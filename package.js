Package.describe({
  name: "kestanous:sqlite-collections",
  version: "0.0.1",
  summary: "Mongo collections with SQLite backend for offline use"
});

Cordova.depends({
  // io.litehelpers.cordova.sqlite
  'cordova-sqlite-storage': '0.7.10'
});

Package.onUse(function (api) {
  api.versionsFrom('METEOR@1.2');
  
  //use everywhere
  api.use([
    'ecmascript', 
    'reactive-var', 
    'mongo'
  ]);
  api.addFiles('mockCollections.js', ['server', 'web.browser']);

  //use on Cordova only
  api.use([
    'tracker', 
    'underscore',
    'diff-sequence', 
    'mongo-id', 
    'raix:localforage-serializer@1.2.4-rc.1'
  ], 'web.cordova');
  api.addFiles([
    'sqliteStore.js',
    'sqlite.js',
    'collections.js'
  ], 'web.cordova');

  api.export('SQLite');
  api.export('sqliteStore');
  
});
