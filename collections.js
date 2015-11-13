SQLite = {
  _collections: [],
  ready: function () {
    return _.all(SQLite._collections, function (col) {
      return col.ready.get();
    });
  }
}; //Global handle

SQLite.Collection = class SQLiteCollection extends Mongo.Collection {

  constructor(name, options) {
    if (name !== ''+name || !name.length) {
      throw new Meteor.Error('missing-name', 'SQLite.Collection requires a collection name');
    }
    //everything stays the same but fake out the collection name
    super('_' + name, options); //this tricks ddp and does not auto-add our docs
    this.sqlite = new SQLiteTable(name); //this takes asyc time, so do it first
    this._serverName = name; //keep a ref to our real name, so we can add/remove docs
    this.ready = ReactiveVar(false);
    this._currentFilters = []
    this._userFilter = options && options.filter
    this._store = new sqliteStore(this);
    if ( !Meteor.connection.registerStore(name, this._store) ) { 
      throw new Error(`There is already a collection named "${name}"`); 
    }

    _.each(['insert', 'update', 'remove', 'upsert'], (method) => {
      //noop forces it to run without local collection (intentionally miss aligned as _[name])
      this._connection._methodHandlers[`/${this.name}/method`] = function () {}  
    });

    //add all the docs that pass the filter when ready
    this._collection.pauseObservers();
    this.testArray = []
    this.sqlite.ready.then(() => {
      this.sqlite.findByFilters(this._currentFilters).then((docs) => {
        _.each(docs, (doc) => { this._collection.insert(doc); });
        this._collection.resumeObservers();
      })//.catch( (e) => { console.warn(`sqlite table "${this._serverName}": ` + e) });
      this._initialize();

    })//.catch( (e) => { console.warn(`sqlite table "${this._serverName}" failed to load`) });
  }

  _initialize() {
    Tracker.autorun( (c) => {
      if (Meteor.status().connected) {
        this._uploadAll();
      }
      if (c.firstRun) { 
        this.ready.set(true); 
        this._store.runInit();
      }
    });
  }

  //server to SQLite and client
  _added(id, doc) {
    if (!id) { return; }
    var result = this._addAndFilter(id, doc);
    if (result.isPresent && !this._collection._docs._map[id]) {
      this._collection.insert(_.extend({_id: id}, doc));
    }
  }
  _changed(id, fields, oldDoc, replace) {
    if (!id || !oldDoc) { return; }
    var newDoc = replace ? fields : _.extend(oldDoc, fields);
    var result = this._addAndFilter(id, newDoc);
    if (result.isPresent) {
      let modifier = {};
      _.each(fields, function (value, key) {
        if (value === undefined) {
          if (!modifier.$unset)
            modifier.$unset = {};
          modifier.$unset[key] = 1;
        } else {
          if (!modifier.$set)
            modifier.$set = {};
          modifier.$set[key] = value;
        }
      });
      this._collection.update(id, modifier)
    }
  }
  _removed(id) {
    if (!id) { return; }
    this.sqlite.remove(id)
    this._collection.remove(id)
  }

  //client to SQLite
  insert() {
    var doc = arguments[0];
    if (!_.isObject(doc)) {
      //basically the same error the normal insert would give
      throw new Meteor.Error(400, 'insert requires an object argument');
    }
    if (doc._id) {
      //we would have to do a sql query for every insert otherwise...
      throw new Meteor.Error(400, 'inserts with _id are disabled with SQLite Collections');
    }

    //if the doc does not match the filter we will not run insert
    //same thing that would happen on a normal insert, without having to call it
    id = LocalCollection._useOID ? new MongoID.ObjectID() : Random.id(); 

    //we add the doc to SQLite here and try to upload it
    var result = this._addAndFilter(id, doc, true)
    result.promise.then(() => { this._uploadInserts() })//.catch(function (e) { console.error(e); });

    //if it matched the current filters we add it now
    if (result.isPresent) { 
      doc._id = id; this._collection.insert(doc); 
    }
    return id
  }
  update() { //currently [[options]] is not supported
    //be sure we have a good id
    this._throwIfSelectorIsNotId(arguments[0], 'update');
    id = _.isString(arguments[0]) ? arguments[0] : arguments[0]._id;
    
    //check if the doc is preset in minimongo
    doc = this._collection._docs._map[id];
    if (doc) {
      //we could run update and find the result but this is faster
      this._collection._modifyAndNotify(doc, arguments[1], {}); //mutates doc, we ignore notify (arg 3)  

      //we update SQLite, save the mutation object, and try to upload
      let result = this._addAndFilter(id, doc, true, arguments[1]);
      result.promise.then(() => { this._uploadUpdates() })//.catch(function (e) { console.error(e); });
    
      if (result.isPresent) { //the updated doc still passes the filter test
        //we could call apply and pass all the options but SQLite doesn't support them so...
        this._collection.update(id, arguments[1]); 
      } else { //the doc is no longer valid and need to be culled
        this._collection.remove(id);
      }
      return 1; //we definitely got something, even it it was a no-op
    } else { //TODO: DRY this code with the above
      this.sqlite.findOne(id).then( (doc) => {
        if (!doc) { return 0; } //break! no doc exists to update

        //clean up our doc a bit
        id = doc._id; delete doc._id;

        //mutate the doc - see above
        this._collection._modifyAndNotify(doc, arguments[1], {}); 

        //update/upload -- see above
        let result = this._addAndFilter(id, doc, true, arguments[1]);
        result.promise.then(() => { this._uploadUpdates() })//.catch(function (e) { console.error(e); });

        //the doc as become valid, we can do a direct insertion
        if (result.isPresent) { doc._id = id; this._collection.insert(doc); }
        return 1;
      })
    }
  }
  remove() {
    //get a valid id
    this._throwIfSelectorIsNotId(arguments[0], 'remove')
    id = _.isString(arguments[0]) ? arguments[0] : arguments[0]._id;

    //remove doc from SQLite and try to upload removal request now
    this.sqlite.remove(id).then(() => {  this._uploadRemoves() })//.catch(function (e) { console.error(e); });

    return this._collection.remove(id);
  }
  upsert() { //overrides original
    throw new Meteor.Error(405, "Method Not Allowed. upsert disabled for SQLite Collections");
  }

  //SQLite to server
  _uploadAll() {
    return this._uploadInserts().then(() => { this._uploadUpdates() }).then(() => { this._uploadRemoves() })
    .catch(function (e) {
      console.error(e) //log errors but don't kill the db
    });
  }
  _uploadInserts() {
    return new Promise( (resolve, reject) => {this._uploadRecursive(this.sqlite.keys.INSERT, resolve, reject) });
  }
  _uploadUpdates() {
    return new Promise( (resolve, reject) => {this._uploadRecursive(this.sqlite.keys.UPDATE, resolve, reject) });
  }
  _uploadRemoves() {
    return new Promise( (resolve, reject) => {this._uploadRecursive(this.sqlite.keys.REMOVE, resolve, reject) });
  }
  _uploadRecursive(key, resolve, reject) {
    if (!Meteor.status().connected) { return; }
    this.sqlite.getSyncDocs(key, 1).then((results) => {
      if (!results.length) { resolve(); return; }
      let item = results[0]
      let done = (e, r) => {
        if (e && !e.error == 409) { // 409 means we already uploaded it
          reject(e)
        } else {
          this.sqlite.removeSyncDoc(item.key).then(() => {
            this._uploadRecursive(key, resolve, reject)
          })
        }
      }
      if (key == this.sqlite.keys.INSERT) {
        item.value._id = item.key
        this._connection.call(`/${this._serverName}/insert`, item.value,  done);
      } else if (key == this.sqlite.keys.UPDATE) {
        this._connection.call(`/${this._serverName}/update`, {_id: item.key}, item.value,  done);
      } else if (key == this.sqlite.keys.REMOVE) {
        this._connection.call(`/${this._serverName}/remove`, {_id: item.key}, done);
      } else { reject(`unknown key ${key}`) }
    }).catch(reject);
  }

  //filters functions
  _filter(doc) { 
    filter = this._userFilter && this._userFilter(doc);
    return filter ? filter : null; 
  }
  addFilter(filter, wipe) {
    return new Promise( (resolve, reject) => {
      if (this._currentFilters.indexOf(filter) == -1 || wipe) {
        if (wipe) {
          this._currentFilters = [filter];
        } else {
          this._currentFilters.push(filter);
        }
        this._collection.pauseObservers();
        this._updateFilters().then(() => {
          this._collection.resumeObservers();
          Tracker.afterFlush(function () {
            resolve();
          });
        }).catch(reject);
      } else { resolve(); }
    });
  }
  removeFilter(filter, wipe) {
    return new Promise( (resolve, reject) => {
      index = this._currentFilters.indexOf(filter);
      if (index != -1 || wipe) {
        if (wipe) {
          this._currentFilters = []
        } else {
          this._currentFilters.splice(index, 1);
        }
        this._collection.pauseObservers();
        this._updateFilters().then(() => {
          this._collection.resumeObservers();
          Tracker.afterFlush(function () {
            resolve();
          });
        }).catch(reject);
      } else { resolve(); }
    });
  }
  _updateFilters() {
    return new Promise( (resolve, reject) => {
      this.sqlite.findByFilters(this._currentFilters).then((docs) => {
        this._collection.remove({});
        _.each(docs, (doc) => { this._collection.insert(doc); });
        resolve()
      }).catch(reject)
    });
  } 

  //helpers
  count(filter) {
    return new Promise( (resolve, reject) => { 
      if (filter || _.isNull(filter)) {
        this.sqlite.countByFilter(filter).then(resolve)//.catch(reject)
      } else {
        this.sqlite.count().then(resolve)//.catch(reject)
      }
    });
  }

  //_helpers
  _clearCashe() { 
    this.sqlite.clear(true) 
  }

  _addAndFilter(id, doc, changed, isUpdate) {
    var isPresent = false;
    var filter = this._filter(doc);
    if (!filter || _.contains(this._currentFilters, filter)) {
      isPresent = true;
    }
    return { 
      isPresent: isPresent, 
      promise: this.sqlite.insert({id: id,doc: doc, filter: filter}, changed, isUpdate)
    };
  }

  _throwIfSelectorIsNotId(selector, methodName) {
    if (!LocalCollection._selectorIsIdPerhapsAsObject(selector)) {
      throw new Meteor.Error(
        403, "Not permitted. Untrusted code may only " + methodName +
        " documents by ID.");
    }
  }
}
