const inherits = require('util').inherits;
const EventEmitter = require('events').EventEmitter;
const forwardEvents = require('forward-emitter');
const _ = require('lodash');
const Broker = require('./Broker');
const SubscriberSessionAsPromised = require('./SubscriberSessionAsPromised');

module.exports = {
  create() {
    const args = Array.prototype.slice.call(arguments);
    return new Promise((resolve, reject) => {
      Broker.create(
        ...args.concat((err, broker) => {
          if (err && !broker) return reject(err);
          broker.promises = true;
          const brokerAsPromised = new BrokerAsPromised(broker);
          if (!err) return resolve(brokerAsPromised);
          err.broker = Symbol('broker-as-promised');
          Object.defineProperty(err, err.broker, {
            enumerable: false,
            value: brokerAsPromised,
          });
          return reject(err);
        })
      );
    });
  },
};

inherits(BrokerAsPromised, EventEmitter);

function BrokerAsPromised(broker) {
  const methods = ['connect', 'nuke', 'purge', 'shutdown', 'bounce', 'publish', 'forward', 'unsubscribeAll'];
  const self = this;

  this.realBroker = broker;

  forwardEvents(this.realBroker, this);

  _.each(methods, (method) => {
    self[method] = function () {
      const args = Array.prototype.slice.call(arguments);
      return new Promise((resolve, reject) => {
        self.realBroker[method](
          ...args.concat((err, result) => {
            if (err) return reject(err);
            resolve(result);
          })
        );
      });
    };
  });

  this.config = this.realBroker.config;
  this.getConnections = this.realBroker.getConnections;

  this.subscribe = function () {
    const args = Array.prototype.slice.call(arguments);
    return new Promise((resolve, reject) => {
      self.realBroker.subscribe(
        ...args.concat((err, session) => {
          if (err) return reject(err);
          resolve(new SubscriberSessionAsPromised(session));
        })
      );
    });
  };

  this.subscribeAll = function () {
    const args = Array.prototype.slice.call(arguments);
    return new Promise((resolve, reject) => {
      self.realBroker.subscribeAll(
        ...args.concat((err, sessions) => {
          if (err) return reject(err);
          resolve(
            sessions.map((session) => {
              return new SubscriberSessionAsPromised(session);
            })
          );
        })
      );
    });
  };

  /* eslint-disable-next-line no-multi-assign */
  this.getFullyQualifiedName = this.qualify = function (vhost, name) {
    return self.realBroker.qualify(vhost, name);
  };
}
