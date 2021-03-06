/// <reference path="kubernetesApiGlobals.ts"/>
/// <reference path="kubernetesApiHelpers.ts"/>
/// <reference path="kubernetesApiPlugin.ts"/>

module KubernetesAPI {

  var log = Logger.get('k8s-objects');

  function getKey(kind:string, namespace?: string) {
    return namespace ? namespace + '-' + kind : kind;
  }

  function beforeSend(request) {
    var token = HawtioOAuth.getOAuthToken();
    if (token) {
      request.setRequestHeader('Authorization', 'Bearer ' + token);
    }
  }

  // Allow clients to add other types to force polling under whatever circumstances
  export var pollingOnly = [WatchTypes.PROJECTS, WatchTypes.IMAGE_STREAM_TAGS];

  /**
   *  Manages the array of k8s objects for a client instance
   **/
  class ObjectList {
    public triggerChangedEvent = _.debounce(() => {
      this._ee.emit(WatchActions.ANY, this._objects);
    }, 75, { trailing: true });

    private _ee:EventEnabled = undefined;
    private _initialized = false;
    private _objects:Array<any> = [];
    private log:Logging.Logger = log;

    constructor(private _kind:string, private namespace?:string) {
      this._ee = smokesignals.convert(this);
      if (this.log.enabledFor(Logger.DEBUG)) {
        this._ee.on(WatchActions.ADDED, (object) => {
          this.log.debug("added", this.kind, ":", object);
        });
        this._ee.on(WatchActions.MODIFIED, (object) => {
          this.log.debug("modified", this.kind, ":", object);
        });
        this._ee.on(WatchActions.DELETED, (object) => {
          this.log.debug("deleted", this.kind, ":", object);
        });
        this._ee.on(WatchActions.ANY, (objects) => {
          this.log.debug(this.kind, "changed:", objects);
        });
        this._ee.on(WatchActions.INIT, (objects) => {
          this.log.debug(this.kind, "initialized");
        });
      }
      this._ee.on(WatchActions.ANY, (objects) => {
        this.initialize();
      });
    };

    public get kind() {
      return this._kind;
    }

    public initialize() {
      if (this.initialized) {
        return;
      }
      this._initialized = true;
      this._ee.emit(WatchActions.INIT, this._objects);
      this.triggerChangedEvent();
    }

    public get initialized() {
      return this._initialized;
    }

    public get events() {
      return this._ee;
    }
    
    public get objects() {
      return this._objects;
    }

    public set objects(objs:any[]) {
      this._objects.length = 0;
      _.forEach(objs, (obj) => {
        if (!obj.kind) {
          obj.kind = toKindName(this.kind);
        }
        this._objects.push(obj);
      });
      this.initialize();
      this.triggerChangedEvent();
    }

    public hasNamedItem(item:any) {
      return _.some(this._objects, (obj:any) => {
        return getName(obj) === getName(item);
      });
    }

    public getNamedItem(name:string) {
      return _.find(this._objects, (obj:any) => {
        return getName(obj) === name;
      });
    }

    // filter out objects from other namespaces that could be returned
    private belongs(object) {
      if (this.namespace && getNamespace(object) !== this.namespace) {
        return false;
      }
      return true;
    }

    public added(object) {
      if (!this.belongs(object)) {
        return;
      }
      if (!object.kind) {
        object.kind = toKindName(this.kind);
      }
      if (_.some(this._objects, (obj) => {
        return equals(obj, object);
      })) {
        this.modified(object);
        return;
      }
      this._objects.push(object);
      this._ee.emit(WatchActions.ADDED, object);
      this.triggerChangedEvent();
    };

    public modified(object) {
      if (!this.belongs(object)) {
        return;
      }
      if (!object.kind) {
        object.kind = toKindName(this.kind);
      }
      if (!_.some(this._objects, (obj) => {
        return equals(obj, object);
      })) {
        this.added(object);
        return;
      }
      _.forEach(this._objects, (obj) => {
        if (equals(obj, object)) {
          angular.copy(object, obj);
          this._ee.emit(WatchActions.MODIFIED, object);
          this.triggerChangedEvent();
        }
      }, this);
    };

    public deleted(object) {
      if (!this.belongs(object)) {
        return;
      }
      var deleted = _.remove(this._objects, (obj) => {
        return equals(obj, object);
      }, this);
      if (deleted) {
        this._ee.emit(WatchActions.DELETED, deleted[0]);
        this.triggerChangedEvent();
      }
    };
  };

  interface CompareResult {
    added:Array<any>;
    modified:Array<any>;
    deleted:Array<any>;
  }

  function compare(old:Array<any>, _new:Array<any>):CompareResult {
    var answer = <CompareResult> {
      added: [],
      modified: [],
      deleted: []
    };
    _.forEach(_new, (newObj) => {
      var oldObj = _.find(old, (o) => equals(o, newObj));
      if (!oldObj) {
        answer.added.push(newObj);
        return;
      }
      if (angular.toJson(oldObj) !== angular.toJson(newObj)) {
        answer.modified.push(newObj);
      }
    });
    _.forEach(old, (oldObj) => {
      var newObj = _.find(_new, (o) => equals(o, oldObj));
      if (!newObj) {
        answer.deleted.push(oldObj);
      }
    });
    return answer;
  }

  /*
   * Manages polling the server for objects that don't support websocket connections
   */
  class ObjectPoller {

    private _lastFetch = <Array<any>> [];
    private log:Logging.Logger = undefined;
    private _connected = false;
    private _interval = 5000;
    private retries:number = 0;
    private tCancel:any = undefined;

    constructor(private restURL:string, private handler:WSHandler) {
      this.log = log; 
      this._lastFetch = this.handler.list.objects;
    };

    public get connected () {
      return this._connected;
    };

    private doGet() {
      if (!this._connected) {
        return;
      } 
      $.ajax(this.restURL, <any>{
        method: 'GET',
        success: (data) => {
          if (!this._connected) {
            return;
          }
          log.debug(this.handler.kind, "fetched data:", data);
          var items  = (data && data.items) ? data.items : [];
          var result = compare(this._lastFetch, items);
          this._lastFetch = items;
          _.forIn(result, (items:any[], action:string) => {
            _.forEach(items, (item:any) => {
              var event = {
                data: angular.toJson({
                  type: action.toUpperCase(),
                  object: _.clone(item)
                  }, true)
                };
              this.handler.onmessage(event);
            });
          });
          this.handler.list.initialize();
          //log.debug("Result: ", result);
          if (this._connected) {
            this.tCancel = setTimeout(() => {
              log.debug(this.handler.kind, "polling");
              this.doGet();
            }, this._interval);
          }
        },
        error: (jqXHR, text, status) => {
          if (!this._connected) {
            return;
          }
          var error = getErrorObject(jqXHR);
          if (jqXHR.status === 403) {
            this.log.info(this.handler.kind, "- Failed to poll objects, user is not authorized");
            return;
          }
          if (this.retries >= 3) {
            this.log.debug(this.handler.kind, "- Out of retries, stopping polling, error: ", error);
            this.stop();
            if (this.handler.error) {
              this.handler.error(error);
            }
          } else {
            this.retries = this.retries + 1;
            this.log.debug(this.handler.kind, "- Error polling, retry #", this.retries + 1, " error: ", error);
            this.tCancel = setTimeout(() => {
              this.doGet();
            }, this._interval);
          }
        },
        beforeSend: beforeSend
      });
    };

    public start() {
      if (this._connected) {
        return;
      }
      this._connected = true;
      this.tCancel = setTimeout(() => {
        this.doGet();
      }, 1);
    };

    public stop() {
      this._connected = false;
      this.log.debug(this.handler.kind, " - disconnecting");
      if (this.tCancel) {
        this.log.debug(this.handler.kind, " - cancelling polling");
        clearTimeout(this.tCancel);
        this.tCancel = undefined;
      }
    };

    public destroy() {
      this.stop();
      this.log.debug(this.handler.kind, " - destroyed");
    }

  }

  /**
   * Manages the websocket connection to the backend and passes events to the ObjectList
   */
  class WSHandler {
    private retries:number = 0;
    private connectTime:number = 0;
    private socket:WebSocket;
    private poller:ObjectPoller;
    private self:CollectionImpl = undefined;
    private _list:ObjectList;
    private log:Logging.Logger = undefined;
    private messageLog:Logging.Logger = undefined;
    private destroyed = false;

    constructor(private _self:CollectionImpl) {
      this.self = _self;
      this.log = Logger.get('KubernetesAPI.WSHandler'); 
      this.messageLog = Logger.get('KubernetesAPI.WSHander.messages');
    }

    set list(_list:ObjectList) {
      this._list = _list;
    }

    get list() {
      return this._list || <ObjectList> { objects: [] };
    }

    get collection() {
      return this._self;
    }

    get error() {
      return this._self.options.error;
    }

    get kind() {
      return this._self.kind;
    }

    private setHandlers(self:WSHandler, ws:WebSocket) {
      _.forIn(self, (value, key) => {
        if (_.startsWith(key, 'on')) {
          var evt = key.replace('on', '');
          // this.log.debug("Adding event handler for '" + evt + "' using '" + key + "'");
          ws.addEventListener(evt, (event) => {
            this.messageLog.debug("received websocket event: ", event);
            self[key](event);
          });
        }
      });
    };

    public send(data:any) {
      if (!_.isString(data)) {
        data = angular.toJson(data);
      }
      this.socket.send(data);
    }

    shouldClose(event) {
      if (this.destroyed  && this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.log.debug("Connection destroyed but still receiving messages, closing websocket, kind: ", this.self.kind, " namespace: ", this.self.namespace);
        try {
          this.log.debug("Closing websocket for kind: ", this.self.kind);
          this.socket.close()
        } catch (err) {
          // nothing to do, assume it's already closed
        }
        return true;
      }
      return false;
    }

    onmessage(event) {
      if (this.shouldClose(event)) {
        this.log.debug("Should be closed!");
        return;
      }
      var data = JSON.parse(event.data);
      var eventType = data.type.toLowerCase();
      this._list[eventType](data.object);
    };

    onopen(event) {
      this.log.debug("Received open event for kind: ", this.self.kind, " namespace: ", this.self.namespace);
      if (this.shouldClose(event)) {
        return;
      }
      this.retries = 0;
      this.connectTime = new Date().getTime();
    };

    onclose(event) {
      this.log.debug("Received close event for kind: ", this.self.kind, " namespace: ", this.self.namespace);
      if (this.destroyed) {
        this.log.debug("websocket destroyed for kind: ", this.self.kind, " namespace: ", this.self.namespace);
        delete this.socket;
        return;
      }
      if (this.retries < 3 && this.connectTime && (new Date().getTime() - this.connectTime) > 5000) {
        var self = this;
        setTimeout(() => {
          this.log.debug("Retrying after connection closed: ", event);
          this.retries = this.retries + 1;
          this.log.debug("watch ", this.self.kind, " disconnected, retry #", this.retries);
          var ws = this.socket = new WebSocket(this.self.wsURL);
          this.setHandlers(self, ws);
        }, 5000);
      } else {
        this.log.debug("websocket for ", this.self.kind, " closed, event: ", event);
        if (!event.wasClean) {
          this.log.debug("Switching to polling mode");
          delete this.socket;
          this.poller = new ObjectPoller(this.self.restURL, this);
          this.poller.start();
        }
      }
    };

    onerror(event) {
      this.log.debug("websocket for kind: ", this.self.kind, " received an error: ", event);
      if (this.shouldClose(event)) {
        return;
      }
    }

    get connected():boolean {
      return (this.socket && this.socket.readyState === WebSocket.OPEN) || (this.poller && this.poller.connected);
    };

    connect() {
      if (this.destroyed) {
        return;
      }
      // in case a custom URL is going to be used
      if (this.self.restURL === '' && this.self.wsURL === '') {
        setTimeout(() => {
          this.connect();
        }, 500);
        return;
      }
      if (!this.socket && !this.poller) {
        if (_.some(pollingOnly, (kind) => kind === this.self.kind)) {
          this.log.info("Using polling for kind: ", this.self.kind);
          this.poller = new ObjectPoller(this.self.restURL, this);
          this.poller.start();
        } else {
          var doConnect = () => {
            var wsURL = this.self.wsURL;
            if (wsURL) {
              this.log.debug("Connecting websocket for kind: ", this.self.kind);
              this.socket = new WebSocket(wsURL);
              this.setHandlers(this, this.socket);
            } else {
              log.info("No wsURL for kind: " + this.self.kind);
            }
          };
          $.ajax(this.self.restURL, <any> {
            method: 'GET',
            processData: false,
            success: (data) => {
              this._list.objects = data.items || [];
              setTimeout(() => {
                doConnect();
              }, 10);
            }, error: (jqXHR, text, status) => {
              var err = getErrorObject(jqXHR);
              if (jqXHR.status === 403) {
                this.log.info("Failed to fetch data while connecting to backend for type: ", this.self.kind, ", user is not authorized");
                this._list.objects = [];
              } else {
                this.log.info("Failed to fetch data while connecting to backend for type: ", this.self.kind, " error: ", err);
                setTimeout(() => {
                  doConnect();
                }, 10);
              }
            },
            beforeSend: beforeSend
          });
        }
      }
    };

    destroy() {
      this.destroyed = true;
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.log.debug("Closing websocket for kind: ", this.self.kind, " namespace: ", this.self.namespace);
          this.socket.close();
          this.log.debug("Close called on websocket for kind: ", this.self.kind, " namespace: ", this.self.namespace);
        } catch (err) {
          // nothing to do, assume it's already closed
        }
      }
      if (this.poller) {
        this.log.debug("Destroying poller for kind: ", this.self.kind, " namespace: ", this.self.namespace);
        this.poller.destroy();
      }
    }
  }

  /*
   * Implements the external API for working with k8s collections of objects
   */
  export class CollectionImpl implements Collection {

    private _kind:string;
    private _namespace:string;
    private _path:string;
    private _apiVersion:string;
    private handlers:WSHandler = undefined;
    private list:ObjectList = undefined;

    constructor(private _options:K8SOptions) {
      this._kind = _options.kind;
      this._apiVersion = _options.apiVersion;
      this._namespace = _options.namespace || null;

      var pref = this.getPrefix();

      if (this._namespace) {
        this._path = UrlHelpers.join(pref, 'namespaces', this._namespace, this._kind);
      } else {
        this._path = UrlHelpers.join(pref, this._kind);
      }
      this.handlers = new WSHandler(this);
      var list = this.list = new ObjectList(_options.kind, _options.namespace);
      this.handlers.list = list;
      log.debug("creating new collection for", this.kind, " namespace: ", this.namespace);
    };

    public get options():K8SOptions {
      return this._options;
    }

    private get _restUrl() {
      if (this.options.urlFunction && angular.isFunction(this.options.urlFunction)) {
        var answer = this.options.urlFunction(this.options);
        if (answer === null || !answer) {
          return null;
        }
        return new URI(answer);
      } else {
        return new URI(UrlHelpers.join(masterApiUrl(), this._path));
      }
    }

    private get _wsUrl() {
      if (this.options.urlFunction && angular.isFunction(this.options.urlFunction)) {
        var answer = this.options.urlFunction(this.options);
        if (answer === null || !answer) {
          return null;
        }
        return wsUrl(answer).query(<any> {
          watch: true,
          access_token: HawtioOAuth.getOAuthToken()
        });
      } else {
        var url = UrlHelpers.join(masterApiUrl(), this._path);
        var location = Core.windowLocation();
        if (location && url.indexOf("://") < 0) {
          var hostname = location.hostname;
          if (hostname) {
            var port = location.port;
            if (port) {
              hostname += ":" + port;
            }
            url = UrlHelpers.join(hostname, masterApiUrl(), this._path);
          }
        }
        return wsUrl(url).query(<any> {
          watch: true,
          access_token: HawtioOAuth.getOAuthToken()
        });
      }
    }

    public getKey() {
      return getKey(this._kind, this._namespace);
    };

    public get wsURL() {
      return (this._wsUrl || "").toString();
    };

    public get restURL() {
      return (this._restUrl || "").toString();
    };

    get namespace() {
      return this._namespace;
    };

    get kind() {
      return this._kind;
    };

    get connected():boolean {
      return this.handlers.connected;
    };

    public connect() {
      if (!this.handlers.connected) {
        this.handlers.connect();
      }
    };

    public destroy() {
      this.handlers.destroy();
      /*
      delete this.handlers;
      delete this.list;
      */
    }

    private addLabelFilter(cb:(data:any[]) => void, labelSelector:LabelMap) {
      log.debug("Adding label filter: ", labelSelector);
      var cbOld = cb;
      return (data:any[]) => {
        data = filterByLabel(data, labelSelector);
        cbOld(data);
      };
    }

    // one time fetch of the data...
    public get(cb:(data:any[]) => void, labelSelector?:LabelMap) {
      if (labelSelector) {
        cb = this.addLabelFilter(cb, labelSelector);
      }
      if (!this.list.initialized) {
        this.list.events.once(WatchActions.INIT, cb);
      } else {
        setTimeout(() => {
          cb(this.list.objects);
        }, 10);
      }
    };

    private getPrefix() {
      var pref = prefixForKind(this._kind);
      if (!pref) {
        if (this._apiVersion && _.startsWith(this._apiVersion, 'extensions')) {
          pref = UrlHelpers.join(K8S_EXT_PREFIX, this._apiVersion);
        } else {
          throw new Error('Unknown kind: ' + this._kind);
        }
      }
      return pref;
    }

    private restUrlFor(item:any, useName:boolean = true) {
      var name = getName(item);
      if (useName && !name) {
        log.debug("Name missing from item: ", item);
        return undefined;
      }
      var url = UrlHelpers.join(this._restUrl.toString());
      if (this.options.urlFunction && angular.isFunction(this.options.urlFunction)) {
        // lets trust the url to be correct
      } else {
        if (namespaced(toCollectionName(item.kind))) {
          var namespace = getNamespace(item) || this._namespace;
          var prefix = this.getPrefix();
          var kind = this._kind;
          if (!KubernetesAPI.isOpenShift && (kind === "buildconfigs" || kind === "BuildConfig")) {
            prefix = UrlHelpers.join("/api/v1/proxy/namespaces", namespace, "/services/jenkinshift:80/", prefix);
            log.debug("Using buildconfigs URL override");
          }
          url = UrlHelpers.join(masterApiUrl(), prefix, 'namespaces', namespace, kind);
        }
      }
      if (useName) {
        url = UrlHelpers.join(url, name);
      }
      return url;
    }

    // continually get updates
    public watch(cb:(data:any[]) => void, labelSelector?:LabelMap):(data:any[]) => void {
      if (labelSelector) {
        cb = this.addLabelFilter(cb, labelSelector);
      }
      if (this.list.initialized) {
        setTimeout(() => {
          log.debug(this.kind, "passing existing objects:", this.list.objects);
          cb(this.list.objects);
        }, 10);
      }
      log.debug(this.kind, "adding watch callback:", cb);
      this.list.events.on(WatchActions.ANY, (data) => {
        log.debug(this.kind, "got data:", data);
        cb(data);
      });
      return cb;
    };

    public unwatch(cb:(data:any[]) => void) {
      log.debug(this.kind, "removing watch callback:", cb);
      this.list.events.off(WatchActions.ANY, cb);
    }

    public put(item:any, cb:(data:any) => void, error?:(err:any) => void) {
      var method = 'PUT';
      var url = this.restUrlFor(item);
      if (!this.list.hasNamedItem(item)) {
        // creating a new object
        method = 'POST';
        url = this.restUrlFor(item, false);
      } else {
        // updating an existing object
        var resourceVersion = item.metadata.resourceVersion;
        if (!resourceVersion) {
          var current = this.list.getNamedItem(getName(item));
          resourceVersion = current.metadata.resourceVersion;
          item.metadata.resourceVersion = resourceVersion;
        }
      }
      if (!url) {
        return;
      }
      // Custom checks for specific cases
      switch (this._kind) {
        case WatchTypes.SERVICES:
          if (item.spec.clusterIP === '') {
            delete item.spec.clusterIP;
          }
          break;
        default:

      }
      try {
        $.ajax(url, <any> {
          method: method,
          contentType: 'application/json',
          data: angular.toJson(item),
          processData: false,
          success: (data) => {
            try {
              var response = angular.fromJson(data);
              cb(response);
            } catch (err) {
              cb({});
            }
          }, 
          error: (jqXHR, text, status) => {
            var err = getErrorObject(jqXHR);
            log.debug("Failed to create or update, error: ", err);
            if (error) {
              error(err);
            }
          },
          beforeSend: beforeSend
        });
      } catch (err) {
        error(err);
      }
    };

    public delete(item:any, cb:(data:any) => void, error?:(err:any) => void) {
      var url = this.restUrlFor(item);
      if (!url) {
        return;
      }
      this.list.deleted(item);
      this.list.triggerChangedEvent();
      try {
        $.ajax(url, <any>{
          method: 'DELETE',
          success: (data) => {
            try {
              var response = angular.fromJson(data);
              cb(response);
            } catch (err) {
              cb({});
            }
          },
          error: (jqXHR, text, status) => {
            var err = getErrorObject(jqXHR);
            log.debug("Failed to delete, error: ", err);
            this.list.added(item);
            this.list.triggerChangedEvent();
            if (error) {
              error(err);
            }
          },
          beforeSend: beforeSend
        });
      } catch (err) {
        error(err);
      }
    };
  };

  /*
   * Manages references to collection instances to allow them to be shared between views
   */
  class ClientInstance {
    private _refCount = 0;
    private _collection:CollectionImpl = undefined;

    constructor(_collection:CollectionImpl) {
      this._collection = _collection;
    };

    public get refCount() {
      return this._refCount;
    }

    public addRef() {
      this._refCount = this._refCount + 1;
    };

    public removeRef() {
      this._refCount = this._refCount - 1;
    };

    public get collection() {
      return this._collection;
    };

    public disposable() {
      return this._refCount <= 0;
    };

    public destroy() {
      this._collection.destroy();
      // delete this._collection;
    }
  };

  interface ClientMap {
    [name:string]:ClientInstance;
  }

  /*
   * Factory implementation that's available as an angular service
   */
  class K8SClientFactoryImpl {
    private log:Logging.Logger = Logger.get('k8s-client-factory');
    private _clients = <ClientMap> {};
    public create(options: any, namespace?: any):Collection {
      var kind = options;
      var namespace = namespace;
      var _options = options;
      if (angular.isObject(options)) {
        kind = options.kind;
        namespace = options.namespace || namespace;
      } else {
        _options = {
          kind: kind,
          namespace: namespace
        };
      }
      var key = getKey(kind, namespace);
      if (this._clients[key]) {
        var client = this._clients[key];
        client.addRef();
        this.log.debug("Returning existing client for key: ", key, " refcount is: ", client.refCount);
        return client.collection;
      } else {
        var client = new ClientInstance(new CollectionImpl(_options));
        client.addRef();
        this.log.debug("Creating new client for key: ", key, " refcount is: ", client.refCount);
        this._clients[key] = client;
        return client.collection;
      }
    }

    public destroy(client:Collection, ...handles:Array<(data:any[]) => void>) {
      _.forEach(handles, (handle) => {
        client.unwatch(handle);
      });
      var key = client.getKey();
      if (this._clients[key]) {
        var c = this._clients[key];
        c.removeRef();
        this.log.debug("Removed reference to client with key: ", key, " refcount is: ", c.refCount);
        if (c.disposable()) {
          this._clients[key] = undefined;
          c.destroy();
          this.log.debug("Destroyed client for key: ", key);
        }
      }
    }
  }

  export var K8SClientFactory:K8SClientFactory = new K8SClientFactoryImpl();

  _module.factory('K8SClientFactory', () => {
    return K8SClientFactory;
  });

  var NO_KIND = "No kind in supplied options";
  var NO_OBJECT = "No object in supplied options";
  var NO_OBJECTS = "No objects in list object";

  /*
   * Static functions for manipulating k8s obj3cts
   */

  /*
   * Get a collection
   */
  export function get(options:K8SOptions) {
    if (!options.kind) {
      throw NO_KIND;
    }
    var client = K8SClientFactory.create(options);
    var success = (data:any[]) => {
      if (options.success) {
        try {
          options.success(data);
        } catch (err) {
          log.debug("Supplied success callback threw error: ", err);
        }
      }
      K8SClientFactory.destroy(client);
    }
    client.get(success, options.labelSelector);
    client.connect();
  }

  function handleListAction(options:any, action:(object:any, success:(data:any) => void, error:(err:any) => void) => void) {
    if (!options.object.objects) {
      throw NO_OBJECTS;
    }
    var answer = {};
    var objects = _.cloneDeep(options.object.objects);
    function addResult(id, data) {
      answer[id] = data;
      next();
    };
    function next() {
      if (objects.length === 0) {
        log.debug("processed all objects, returning status");
        try {
          if (options.success) {
            options.success(answer);
          }
        } catch (err) {
          log.debug("Supplied success callback threw error: ", err);
        }
        return;
      }
      var object = objects.shift();
      log.debug("Processing object: ", getName(object));
      var success = (data) => {
      addResult(fullName(object), data);
      };
      var error = (data) => {
      addResult(fullName(object), data);
      };
      action(object, success, error);
    }
    next();
  }

  function normalizeOptions(options:any) {
    log.debug("Normalizing supplied options: ", options);
    // let's try and support also just supplying k8s objects directly
    if (options.metadata || getKind(options) === toKindName(WatchTypes.LIST)) {
      var object = options;
      options = {
        object: object
      };
      if (object.objects) {
        options.kind = toKindName(WatchTypes.LIST);
      }
    }
    if (!options.object) {
      throw NO_OBJECT;
    }
    if (!options.object.kind) {
      if (options.kind) {
        options.object.kind = toKindName(options.kind);
      } else {
        throw NO_KIND;
      }
    }
    log.debug("Options object normalized: ", options);
    return options;
  }

  export function del(options:any) {
    options = normalizeOptions(options);
    // support deleting a list of objects
    if (options.object.kind === toKindName(WatchTypes.LIST)) {
      handleListAction(options, (object:any, success, error) => {
        del({
          object: object,
          success: success,
          error: error
        });
      });
      return;
    }
    options.kind = options.kind || toCollectionName(options.object);
    options.namespace = namespaced(options.kind) ? options.namespace || getNamespace(options.object) : null;
    options.apiVersion = options.apiVersion || getApiVersion(options.object);
    var client = K8SClientFactory.create(options);
    var success = (data) => {
      if (options.success) {
        try {
          options.success(data);
        } catch (err) {
          log.debug("Supplied success callback threw error: ", err);
        }
      }
      K8SClientFactory.destroy(client);
    };
    var error = (err) => {
      if (options.error) {
        try {
          options.error(err);
        } catch (err) {
          log.debug("Supplied error callback threw error: ", err);
        }
      }
      K8SClientFactory.destroy(client);
    };
    client.delete(options.object, success, error);
  }

  /*
   * Add/replace an object, or a list of objects
   */
  export function put(options:any) {
    options = normalizeOptions(options);
    // support putting a list of objects
    if (options.object.kind === toKindName(WatchTypes.LIST)) {
      handleListAction(options, (object:any, success, error) => {
        put({
          object: object,
          success: success,
          error: error
        });
      });
      return;
    }
    options.kind = options.kind || toCollectionName(options.object);
    options.namespace = namespaced(options.kind) ? options.namespace || getNamespace(options.object) : null;
    options.apiVersion = options.apiVersion || getApiVersion(options.object);
    var client = K8SClientFactory.create(options);
    client.get((objects) => {
      var success = (data) => {
        if (options.success) {
          try {
            options.success(data);
          } catch (err) {
            log.debug("Supplied success callback threw error: ", err);
          }
        }
        K8SClientFactory.destroy(client);
      };
      var error = (err) => {
        if (options.error) {
          try {
            options.error(err);
          } catch (err) {
            log.debug("Supplied error callback threw error: ", err);
          }
        }
        K8SClientFactory.destroy(client);
      };
      client.put(options.object, success, error);
    });
    client.connect();
  }

  export function watch(options:K8SOptions) {
    if (!options.kind) {
      throw NO_KIND;
    }
    var client = <Collection> K8SClientFactory.create(options);
    var handle = client.watch(options.success, options.labelSelector);
    var self = {
      client: client,
      handle: handle,
      disconnect: () => {
        K8SClientFactory.destroy(self.client, self.handle);
      }
    };
    client.connect();
    return self;
  }

}


