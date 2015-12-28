var Mingo = require('mingo');
var DB = require('sharedb').DB;

var metaOperators = {
  $comment: true,
  $explain: true,
  $hint: true,
  $maxScan: true,
  $max: true,
  $min: true,
  $orderby: true,
  $returnKey: true,
  $showDiskLoc: true,
  $snapshot: true,
  $count: true,
  $aggregate: true
}

var cursorOperators = {
  $limit: 'limit',
  $skip: 'skip'
}

// In-memory ShareDB database
//
// This adapter is not appropriate for production use. It is intended for
// testing and as an API example for people implementing database adaptors. It
// is fully functional, except it stores all documents & operations forever in
// memory. As such, memory usage will grow without bound, it doesn't scale
// across multiple node processes and you'll lose all your data if the server
// restarts. Query APIs are adapter specific. Use with care.

function MemoryDB(options) {
  if (!(this instanceof MemoryDB)) return new MemoryDB(options);
  DB.call(this, options);

  Mingo.setup({
    key: '_id'
  })

  // Map from collection name -> doc id -> doc snapshot ({v:, type:, data:})
  this.docs = {};

  // Map from collection name -> doc id -> list of operations. Operations
  // don't store their version - instead their version is simply the index in
  // the list.
  this.ops = {};

  this.closed = false;
};
module.exports = MemoryDB;

MemoryDB.prototype = Object.create(DB.prototype);

MemoryDB.prototype.close = function(callback) {
  this.closed = true;
  if (callback) callback();
};

// Persists an op and snapshot if it is for the next version. Calls back with
// callback(err, succeeded)
MemoryDB.prototype.commit = function(collection, id, op, snapshot, callback) {
  var db = this;
  process.nextTick(function() {
    var version = db._getVersionSync(collection, id);
    if (snapshot.v !== version + 1) {
      var succeeded = false;
      return callback(null, succeeded);
    }
    var err = db._writeOpSync(collection, id, op);
    if (err) return callback(err);
    err = db._writeSnapshotSync(collection, id, snapshot);
    if (err) return callback(err);
    var succeeded = true;
    callback(null, succeeded);
  });
};

// Get the named document from the database. The callback is called with (err,
// snapshot). A snapshot with a version of zero is returned if the docuemnt
// has never been created in the database.
MemoryDB.prototype.getSnapshot = function(collection, id, fields, callback) {
  var db = this;
  process.nextTick(function() {
    var snapshot = db._getSnapshotSync(collection, id);
    callback(null, snapshot);
  });
};

// Get operations between [from, to) noninclusively. (Ie, the range should
// contain start but not end).
//
// If end is null, this function should return all operations from start onwards.
//
// The operations that getOps returns don't need to have a version: field.
// The version will be inferred from the parameters if it is missing.
//
// Callback should be called as callback(error, [list of ops]);
MemoryDB.prototype.getOps = function(collection, id, from, to, callback) {
  var db = this;
  process.nextTick(function() {
    var opLog = db._getOpLogSync(collection, id);
    if (to == null) {
      to = opLog.length;
    }
    var ops = clone(opLog.slice(from, to));
    callback(null, ops);
  });
};

// The memory database can do some subset of mongo queries with help of mingo module
MemoryDB.prototype.query = function(collection, query, fields, options, callback) {
  var db = this;
  process.nextTick(function() {
    var collectionDocs = db.docs[collection];

    query = normalizeQuery(query);
    var datas = []

    if (query.$aggregate) {
      for (var id in collectionDocs) {
        var snapshot = db._getSnapshotSync(collection, id);
        datas.push(snapshot.data);
      }

      var agg = new Mingo.Aggregator(query.$aggregate)
      var result = agg.run(datas);
      return callback(null, [], result);
    }

    for (var id in collectionDocs) {
      var snapshot = db._getSnapshotSync(collection, id);
      var data = snapshot.data;
      data.__snapshot = snapshot;
      datas.push(data);
    }

    var mingoQuery = new Mingo.Query(query.$query);
    var results = mingoQuery.find(datas).all();

    if (query.$count) return callback(null, [], results.length);

    var snapshots = [];

    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      var snapshot = result.__snapshot;
      snapshots.push(snapshot);
    }

    callback(null, snapshots);
  });
};


MemoryDB.prototype._writeOpSync = function(collection, id, op) {
  var opLog = this._getOpLogSync(collection, id);

  // This should never actually happen unless there's bugs in livedB. (Or you
  // try to use this memory implementation with multiple frontend servers)
  if (opLog.length < op.v - 1) {
    var err = {
      message: 'Internal consistancy error - database missing parent version'
    };
    return err;
  }
  opLog[op.v] = op;
};

// Create, update, and delete snapshots. For creates and updates, a snapshot
// object will be passed in with a type property. If there is no type property,
// it should be considered a delete
MemoryDB.prototype._writeSnapshotSync = function(collection, id, snapshot) {
  var collectionDocs = this.docs[collection] || (this.docs[collection] = {});
  if (!snapshot.type) {
    delete collectionDocs[id];
  } else {
    collectionDocs[id] = clone(snapshot);
  }
};

MemoryDB.prototype._getSnapshotSync = function(collection, id) {
  var collectionDocs = this.docs[collection];
  // We need to clone the snapshot, because ShareDB assumes each call to
  // getSnapshot returns a new object
  var doc = collectionDocs && collectionDocs[id];
  var snapshot;
  if (doc) {
    var data = clone(doc.data);
    snapshot = new MemorySnapshot(id, doc.v, doc.type, data);
  } else {
    var version = this._getVersionSync(collection, id);
    snapshot = new MemorySnapshot(id, version, null, null);
  }
  return snapshot;
};

// `id`, and `v` should be on every returned snapshot
function MemorySnapshot(id, version, type, data) {
  this.id = id;
  this.v = version;
  this.type = type;
  this.data = data;
}

MemoryDB.prototype._getOpLogSync = function(collection, id) {
  var collectionOps = this.ops[collection] || (this.ops[collection] = {});
  return collectionOps[id] || (collectionOps[id] = []);
};

MemoryDB.prototype._getVersionSync = function(collection, id) {
  var collectionOps = this.ops[collection];
  return (collectionOps && collectionOps[id] && collectionOps[id].length) || 0;
};

function clone(obj) {
  return (obj === undefined) ? undefined : JSON.parse(JSON.stringify(obj));
}

function normalizeQuery (expression) {
  // Box queries inside of a $query and clone so that we know where to look
  // for selctors and can modify them without affecting the original object
  var query
  if (expression.$query) {
    query = clone(expression)
    query.$query = clone(query.$query)
  } else {
    query = {$query: {}}
    for (var key in expression) {
      if (metaOperators[key]) {
        query[key] = expression[key]
      } else if (cursorOperators[key]) {
        var findOptions = query.$findOptions || (query.$findOptions = {})
        findOptions[cursorOperators[key]] = expression[key]
      } else {
        query.$query[key] = expression[key]
      }
    }
  }

  return query
}
