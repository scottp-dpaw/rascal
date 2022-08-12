const debug = require('debug')('rascal:Broker');
const format = require('util').format;
const inherits = require('util').inherits;
const EventEmitter = require('events').EventEmitter;
const _ = require('lodash');
const async = require('async');
const tasks = require('./tasks');
const configure = require('../config/configure');
const validate = require('../config/validate');
const fqn = require('../config/fqn');

const preflight = async.compose(validate, configure);
const stub = require('../counters/stub');
const inMemory = require('../counters/inMemory');
const inMemoryCluster = require('../counters/inMemoryCluster').worker;

const maxInterval = 2147483647;

module.exports = {
  create: function create(config, components, next) {
    if (arguments.length === 2) return create(config, {}, arguments[1]);

    const counters = _.defaults({}, components.counters, {
      stub,
      inMemory,
      inMemoryCluster,
    });

    preflight(_.cloneDeep(config), (err, augmentedConfig) => {
      if (err) return next(err);
      new Broker(augmentedConfig, _.assign({}, components, { counters }))._init(next);
    });
  },
};

inherits(Broker, EventEmitter);

function Broker(config, components) {
  const self = this;

  this.vhosts = {};
  this.publications = {};
  this.subscriptions = {};
  this.sessions = [];
  const init = async.compose(tasks.initShovels, tasks.initSubscriptions, tasks.initPublications, tasks.initCounters, tasks.initVhosts);
  const nukeVhost = async.compose(tasks.deleteVhost, tasks.shutdownVhost, tasks.nukeVhost);
  const purgeVhost = tasks.purgeVhost;
  const forewarnVhost = tasks.forewarnVhost;
  const shutdownVhost = tasks.shutdownVhost;
  const bounceVhost = tasks.bounceVhost;

  this.config = _.cloneDeep(config);
  this.promises = false;

  this._init = function (next) {
    debug('Initialising broker');
    self.vhosts = {};
    self.publications = {};
    self.subscriptions = {};
    self.sessions = [];
    init(config, { broker: self, components }, (err) => {
      self.keepActive = setInterval(_.noop, maxInterval);
      setImmediate(() => {
        next(err, self);
      });
    });
  };

  this.connect = function (name, next) {
    if (!self.vhosts[name]) return next(new Error(format('Unknown vhost: %s', name)));
    self.vhosts[name].connect(next);
  };

  this.purge = function (next) {
    debug('Purging all queues in all vhosts');
    async.eachSeries(
      _.values(self.vhosts),
      (vhost, callback) => {
        purgeVhost(config, { vhost }, callback);
      },
      (err) => {
        if (err) return next(err);
        debug('Finished purging all queues in all vhosts');
        next();
      }
    );
  };

  this.shutdown = function (next) {
    debug('Shutting down broker');
    async.eachSeries(
      _.values(self.vhosts),
      (vhost, callback) => {
        forewarnVhost(config, { vhost }, callback);
      },
      (err) => {
        if (err) return next(err);
        self.unsubscribeAll((err) => {
          if (err) self.emit('error', err);
          async.eachSeries(
            _.values(self.vhosts),
            (vhost, callback) => {
              shutdownVhost(config, { vhost }, callback);
            },
            (err) => {
              if (err) return next(err);
              clearInterval(self.keepActive);
              debug('Finished shutting down broker');
              next();
            }
          );
        });
      }
    );
  };

  this.bounce = function (next) {
    debug('Bouncing broker');
    self.unsubscribeAll((err) => {
      if (err) self.emit('error', err);
      async.eachSeries(
        _.values(self.vhosts),
        (vhost, callback) => {
          bounceVhost(config, { vhost }, callback);
        },
        (err) => {
          if (err) return next(err);
          debug('Finished bouncing broker');
          next();
        }
      );
    });
  };

  this.nuke = function (next) {
    debug('Nuking broker');
    self.unsubscribeAll((err) => {
      if (err) self.emit('error', err);
      async.eachSeries(
        _.values(self.vhosts),
        (vhost, callback) => {
          nukeVhost(config, { vhost, components }, callback);
        },
        (err) => {
          if (err) return next(err);
          self.vhosts = {};
          self.publications = {};
          self.subscriptions = {};
          clearInterval(self.keepActive);
          debug('Finished nuking broker');
          next();
        }
      );
    });
  };

  this.publish = function (name, message, overrides, next) {
    if (arguments.length === 3) return self.publish(name, message, {}, arguments[2]);
    if (_.isString(overrides)) return self.publish(name, message, { routingKey: overrides }, next);
    if (!self.publications[name]) return next(new Error(format('Unknown publication: %s', name)));
    self.publications[name].publish(message, overrides, next);
  };

  this.forward = function (name, message, overrides, next) {
    if (arguments.length === 3) return self.forward(name, message, {}, arguments[2]);
    if (_.isString(overrides)) return self.forward(name, message, { routingKey: overrides }, next);
    if (!config.publications[name]) return next(new Error(format('Unknown publication: %s', name)));
    self.publications[name].forward(message, overrides, next);
  };

  this.subscribe = function (name, overrides, next) {
    if (arguments.length === 2) return self.subscribe(name, {}, arguments[1]);
    if (!self.subscriptions[name]) return next(new Error(format('Unknown subscription: %s', name)));
    self.subscriptions[name].subscribe(overrides, (err, session) => {
      if (err) return next(err);
      self.sessions.push(session);
      next(null, session);
    });
  };

  this.subscribeAll = function (filter, next) {
    if (arguments.length === 1)
      return self.subscribeAll(() => {
        return true;
      }, arguments[0]);
    const filteredSubscriptions = _.chain(config.subscriptions).values().filter(filter).value();
    async.mapSeries(
      filteredSubscriptions,
      (subscriptionConfig, cb) => {
        self.subscribe(subscriptionConfig.name, (err, subscription) => {
          if (err) return cb(err);
          cb(null, subscription);
        });
      },
      next
    );
  };

  this.unsubscribeAll = function (next) {
    async.each(
      self.sessions.slice(),
      (session, cb) => {
        self.sessions.shift();
        session.cancel(cb);
      },
      next
    );
  };

  this.getConnections = function () {
    return Object.keys(self.vhosts).map((name) => {
      return self.vhosts[name].getConnectionDetails();
    });
  };

  /* eslint-disable-next-line no-multi-assign */
  this.getFullyQualifiedName = this.qualify = function (vhost, name) {
    return fqn.qualify(name, config.vhosts[vhost].namespace);
  };

  this._addVhost = function (vhost) {
    self.vhosts[vhost.name] = vhost;
  };

  this._addPublication = function (publication) {
    self.publications[publication.name] = publication;
  };

  this._addSubscription = function (subscription) {
    self.subscriptions[subscription.name] = subscription;
  };
}
