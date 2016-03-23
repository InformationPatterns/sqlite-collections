SQLite = {} //Global handle

SQLite.Collection = class SQLiteCollection extends Mongo.Collection {
  constructor(name, options) {
    super(name, options);
    if (Meteor.isClient) {
      this.ready = ReactiveVar(true);
      this.status = ReactiveVar({
        ready: true,
        count: 0,
        total: 0
      });
    }
    self.batchInsert = {}
    if (Meteor.server) {
      var self = this;
      methods = {}
      methods[`/${name}/batchInsert`] = function (docs) {
        if (!docs || !docs.length) { return 0; }
        var userId = this.userId
        , user = Meteor.users.findOne(userId)
        docs.forEach(function (doc) {
          // Any allow returns true means proceed. Throw error if they all fail.
          if (self.batchInsert.allow) {
            if (!self.batchInsert.allow(user, doc)) {
              throw new Meteor.Error(403, "Access denied");
            }
          } 
          try { self.insert(doc); } catch (e) {} //there may be cases of duplicate _ids, drop and just move on
        });
        return docs.length;
      }
      Meteor.methods(methods);
    }
  }
  addFilter() {
    return new Promise( (resolve, reject) => { resolve() });
  }
  removeFilter() {
    return new Promise( (resolve, reject) => { resolve() });
  }
  count(filter) {
    //we could fake this for real... 
    //run every doc in the db over the filter function and count them
    return new Promise( (resolve, reject) => { resolve(0) });
  }
}

