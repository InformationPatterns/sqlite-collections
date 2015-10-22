sqliteStore = function (collection) {
  this.beginUpdate = (batchSize, reset) => {

    if (batchSize > 1 || reset) {
      collection._collection.pauseObservers();
    }

    if (reset) {
      collection._clearCashe();
      collection._collection.remove({});
    }
  }

  this.update = function (msg) {
    var mongoId = MongoID.idParse(msg.id);
    collection.sqlite.findOne(mongoId).then( (doc) => {
      if (msg.msg === 'replace') {
        var replace = msg.replace;
        if (!replace) {
          if (doc)
            collection._remove(mongoId);
        } else if (!doc) {
          id = replace._id
          delete replace._id
          collection._added(id, replace);
        } else {
          collection._changed(mongoId, replace, doc, true);
        }
        return;
      } else if (msg.msg === 'added') {
        collection._added(mongoId, msg.fields);
      } else if (msg.msg === 'removed') {
        collection._removed(mongoId);
      } else if (msg.msg === 'changed') {
        if (!_.isEmpty(msg.fields)) {
          collection._changed(mongoId, msg.fields, doc);
        }
      } else {
        throw new Error("I don't know how to deal with this message");
      }
    });
  }

  // Called at the end of a batch of updates.
  this.endUpdate = function () {
    collection._collection.resumeObservers();
  }

  // Called around method stub invocations to capture the original versions
  // of modified documents.
  this.saveOriginals = function () {
    collection._collection.saveOriginals();
  }
  this.retrieveOriginals  = function () {
    return collection._collection.retrieveOriginals();
  }

  // Used to preserve current versions of documents across a store reset.
  this.getDoc = (id) => {
    return collection.sqlite.findOne(id);
  }

  return this;
};