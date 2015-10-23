SQLite = {} //Global handle

SQLite.Collection = class SQLiteCollection extends Mongo.Collection {
  constructor(name, options) {
    super(name, options);
    if (Meteor.client) {
      this.ready = ReactiveVar(true);
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

