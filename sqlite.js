/*
* Based on https://github.com/raix/Meteor-localforage-sqlite/blob/master/sqlite.js
* Copyright (c) 2013 @raix, aka Morten N.O. Nørgaard Henriksen, mh@gi-software.com
* Licensed under The MIT License (MIT)
*
* ----------------------------------------
*
* (Could) include code from:
*
* base64-arraybuffer
* https://github.com/niklasvh/base64-arraybuffer
*
* Copyright (c) 2012 Niklas von Hertzen
* Licensed under the MIT license.
*
*/

SQLiteTable = class SQLiteTable {
  constructor(name) {
    this.name = name;
    this.keys = {
      INSERT: 0,
      UPDATE: 1,
      REMOVE: 2
    };


    this.ready = new Promise( (resolve, reject) => {
      document.addEventListener("deviceready", () => {

        if (!sqlitePlugin) { 
          reject('sqlitePlugin not found'); 
          return;
        }

        this.db = sqlitePlugin.openDatabase({
          name: 'offline-collection-store', //database name
          version: 3 //don't backup with iTunes or iCloud
          // androidDatabaseImplementation: 2 //use native classes
          // androidLockWorkaround: 1 //required if we use androidDatabaseImplementation
        });
        // Create our key/value table if it doesn't exist.
        let count = 0;
        let done = () => { //be sure you set up both
          if (count == 1) {
            resolve()
          } else {
            count++
          }
        }
        this.db.transaction( (t) => {
          t.executeSql(`CREATE TABLE IF NOT EXISTS ${this.name} (id string primary key, value, filter)`, [], done)
          t.executeSql(`CREATE TABLE IF NOT EXISTS ${this.name}_server_sync (id integer primary key, key, value, type integer)`, [], done)
        }, reject);
      }, false);
    });
  }
  insert(item, clientChange, updateQuery) {
    return new Promise( (resolve, reject) => {
      this.ready.then( () => {
        if (!_.isString(item.id) || item.id.length < 1 ) { reject('invalid id'); return; }
        //cast all false values to null for clean db transactions
        if (!item.doc) { item.doc = null; }
        if (!item.filter) { item.filter = null; }
        compressedDoc = SQLiteTable.compress(item.doc)
        this.db.transaction( (t) => {
          if (clientChange) {
            if (updateQuery) {
              compressedUpdate = SQLiteTable.compress(updateQuery)
              t.executeSql(` INSERT INTO ${this.name}_server_sync (key, value, type) VALUES (?, ?, ?)`, 
                [item.id, compressedUpdate, this.keys.UPDATE]);
            } else {
              t.executeSql(` INSERT INTO ${this.name}_server_sync (key, value, type) VALUES (?, ?, ?)`, 
                [item.id, compressedDoc, this.keys.INSERT]);
            }
          }
          t.executeSql(`INSERT OR REPLACE INTO ${this.name} (id, value, filter) VALUES (?, ?, ?);`,  
            [ item.id, compressedDoc, item.filter ], 
            () => { resolve( item ); }
          );
        }, reject);
      }).catch(reject);
    });
  }

  remove(id) {
    return new Promise( (resolve, reject) => {
      if (!_.isString(id) || id.length == 0 ) { reject('invalid id'); return; }
      this.ready.then( () => {
        this.db.transaction( (t) => {
          t.executeSql(`DELETE FROM ${this.name} WHERE id = ?`, [id], (t,r) => {resolve(r)});
          t.executeSql(`INSERT INTO ${this.name}_server_sync (key, type) VALUES (?, ?)`, [id,this.keys.REMOVE]);
        }, reject);
      }).catch(reject);
    });
  }

  findOne(id) {
    return new Promise( (resolve, reject) => {
      if (!_.isString(id) || id.length < 1) { reject('invalid id'); return; }
      this.ready.then(() => {
        this.db.transaction( (t) => {
          t.executeSql(`SELECT * FROM ${this.name} WHERE id = ? LIMIT 1`, [id], (t, results) => {
            var result = null;
            if (results.rows.length) {
              item = results.rows.item(0)
              result = SQLiteTable.decompress(item.value);
              result._id = item.id;
            }
            resolve(result);
          });
        }, reject);
      }).catch(reject);
    });
  }

  findByFilters(filters) {
    return new Promise( (resolve, reject) => {
      if (!filters || !_.isNumber(filters.length) ) { reject(`invalid filter ${filters}`); return; }
      var filterString = '';
      for (var i = filters.length - 1; i >= 0; i--) {
        if (filterString) {
          filterString += ", '"+filters[i]+"'";
        } else {
          filterString = "'"+filters[i]+"'";
        }
      };
      this.ready.then(() => {
        this.db.transaction( (t) => {
          t.executeSql(`SELECT * FROM ${this.name} WHERE filter IN (${filterString}) OR filter IS null`, [],
            (t, results) => {
              result = []
              for (let i = results.rows.length - 1; i >= 0; i--) {
                item = SQLiteTable.decompress(results.rows.item(i).value);
                item._id = results.rows.item(i).id
                result.push(item);
              };
              resolve(result);
            }
          );
        }, reject);
      }).catch(reject);
    });
  }

  getSyncDocs(type, limit) {
    return new Promise( (resolve, reject) => {
      limit = limit || 1000
      this.ready.then(() => {
        this.db.transaction( (t) => {
          t.executeSql(`SELECT * FROM ${this.name}_server_sync WHERE type = ${type} LIMIT ${limit}`, [],
            (t, results) => {
              result = []
              for (let i = results.rows.length - 1; i >= 0; i--) {
                let value = results.rows.item(i).value;
                if (value) { value = SQLiteTable.decompress(value); }
                result.push({
                  value: value,
                  key: results.rows.item(i).key
                });
              };
              resolve(result);
            }
          );
        }, reject);
      }).catch(reject);
    });
  }

  removeSyncDoc(id) {
    return new Promise( (resolve, reject) => {
      if (!_.isString(id) || id.length < 1 ) { reject('invalid id'); return; }
      this.ready.then( () => {
        this.db.transaction( (t) => {
          t.executeSql(`DELETE FROM ${this.name}_server_sync WHERE key = ?`, [id], (t,r) => {resolve(r)});
        }, reject);
      }).catch(reject);
    });
  }

  count(name) {
    return new Promise( (resolve, reject) => {
      name = name || this.name
      this.ready.then(() => {
        this.db.transaction( (t) => {
          t.executeSql( `SELECT COUNT(id) as c FROM ${name}`, [],
            (t, results) => { resolve(results.rows.item(0).c); } 
          );
        }, reject);
      }).catch(reject);
    });
  }
  countByFilter(filter) {
    if (filter) {
      var query = 'filter = ?'
    } else {
      var query = 'filter is null'
    }
    return new Promise( (resolve, reject) => {
      this.ready.then(() => {
        this.db.transaction( (t) => {
          t.executeSql( `SELECT COUNT(*) as c FROM ${this.name} WHERE ${query}`, [filter],
            (t, results) => { resolve(results.rows.item(0).c); } 
          );
        }, reject);
      }).catch(reject);
    });
  }

  clear(clean) {
    return new Promise( (resolve, reject) => {
      this.ready.then(() => {
        this.db.transaction((t) => {
          t.executeSql(`DELETE FROM ${this.name}`, [], (t,r) => {resolve(r)});
          if (!clean) { //the api will call clean on server sync 
            t.executeSql(`DELETE FROM ${this.name}_server_sync`);
          }
        }, reject);
      }).catch(reject);
    });
  }
}

SQLiteTable.compress = function (doc) {
  return LZString.compress(EJSON.stringify(doc))
}

SQLiteTable.decompress = function (compressedDoc) {
  return EJSON.parse(LZString.decompress(compressedDoc))
}