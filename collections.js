/*
*
* Based on https://github.com/GroundMeteor/db/tree/es2015-localforage
* Copyright (c) 2013 @raix, aka Morten N.O. Nørgaard Henriksen, mh@gi-software.com
* Licensed under The MIT License (MIT)
*
*/

SQLite = {}; //Global handle
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

    if ( !Meteor.connection.registerStore(name, new sqliteStore(this)) ) { 
      throw new Error(`There is already a collection named "${name}"`); 
    }

    _.each(['insert', 'update', 'remove'], (method) => {
      //noop forces it to run without local collection (intentionally miss aligned as _[name])
      this._connection._methodHandlers[`/${this.name}/method`] = function () {}  
    });


    this._collection.pauseObservers();
    this.sqlite.ready.then(() => {
      this.sqlite.findByFilters(this._currentFilters).then((docs) => {
        _.each(docs, (doc) => { this._collection.insert(doc); });
        this._collection.resumeObservers();
      });
      console.log(`${this._serverName} initialized!`);
      this._initialize();

    }).catch( (e) => { console.warn(`sqlite table "${this._serverName}" failed to load`) });
  }

  _initialize() {
    var ready = false;
    Tracker.autorun( (c) => {
      if (Meteor.status().connected) {
        this._uploadAll();
        if (c.firstRun) { this.ready.set(true); }
      } else {
        if (c.firstRun) { this.ready.set(true); }
      }
    });
  }

  //server to client functions
  _added(id, doc) {
    var result = this._addAndFilter(id, doc)
    if (!result.filter || _.contains(this._currentFilters, result.filter)) {
      this._collection.insert(_.extend({_id: id}, doc))
    } else { //handles edge cases
      this._collection.remove(id)
    }
  }
  _changed(id, fields, oldDoc, replace) {
    var newDoc = replace ? fields : _.extend(oldDoc, fields);
    var result = this._addAndFilter(id, newDoc);

    if (!result.filter || _.contains(this._currentFilters, result.filter)) {
      if (this._collection.findOne(id)) {
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
        this._collection.update(id, modifier);
      } else {
        this._collection.insert(_.extend({_id: id}, oldDoc))
      }
    } else {
      this._collection.remove(id);
    }

  }
  _removed(id) {
    this.sqlite.remove(id)
    this._collection.remove(id)
  }

  //client to SQLite
  insert() {
    var id = this._collection.insert.apply(this._collection, arguments);
    if (id) {
      var doc = this.findOne(id);
      delete doc._id;
      var result = this._addAndFilter(id, doc, true)
      result.promise.then(() => { this._uploadInserts() }).catch(function (e) {
        console.error(e) //log errors but don't kill the db
      });
      if (result.filter && !_.contains(this._currentFilters, result.filter)) {
        this._collection.remove(id);
      }
    }
    return id;
  }
  update(update) {
    var count = this._collection.update.apply(this._collection, arguments);
    if (count) {
      this.find(arguments[0]).forEach((doc) => {
        let id = doc._id;
        delete doc._id;
        let result = this._addAndFilter(id, doc, true, true);
        result.promise.then(() => { this._uploadUpdates() }).catch(function (e) {
          console.error(e) //log errors but don't kill the db
        });
        if (result.filter && !_.contains(this._currentFilters, result.filter)) {
          this._collection.remove(id);
        }
      });
    }
    return count
  }
  remove(remove) {
    ids = this.find(arguments[0]).map( (doc) => { return doc._id });
    this.sqlite.remove(ids).then(() => {  this._uploadRemoves() }).catch(function (e) {
      console.error(e) //log errors but don't kill the db
    });
    return this._collection.remove.apply(this._collection, arguments);
  }
  upsert() { //overrides original
    throw new Error('upsert disabled for SQLite Collections'); 
  }
  
  //sqlite to server
  _uploadAll() {
    return this._uploadInserts().then(() => { this._uploadUpdates() }).then(() => { this._uploadRemoves() }).catch(function (e) {
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
  addFilter(filter) {
    if (this._currentFilters.indexOf(filter) == -1) {
      this._currentFilters.push(filter);
      this._updateFilters();
    }
  }
  removeFilter(filter) {
    index = this._currentFilters.indexOf(filter);
    if (index != -1) {
      this._currentFilters.splice(index, 1);
      this._updateFilters();
    }
  }
  _updateFilters() {
    this.sqlite.findByFilters(this._currentFilters).then((docs) => {
      this._collection.pauseObservers();
      this._collection.remove({});
      _.each(docs, (doc) => { this._collection.insert(doc); });
      this._collection.resumeObservers();
    });
  } 

  //helpers
  _clearCashe() { this.sqlite.clear(true) }

  _addAndFilter(id, doc, changed, isUpdate) {
    filter = this._filter(doc);
    return { 
      filter: filter, 
      promise: this.sqlite.insert({id: id,doc: doc, filter: filter}, changed, isUpdate)
    };
  }
}

// TODOS
// clear data on reconnect
