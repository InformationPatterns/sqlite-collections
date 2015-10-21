SQLite = {} //Global handle

var noop = () => { return true }
SQLite.Collection = class SQLiteCollection extends Mongo.Collection {
  constructor(name, options) {
    super(name, options);
    if (Meteor.client) {
      this.ready = ReactiveVar(true);
    }
  } 
}

