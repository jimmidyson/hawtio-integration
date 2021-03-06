/// <reference path="../../includes.ts"/>
/// <reference path="camelPlugin.ts"/>

module Camel {

   var DELIVERY_PERSISTENT = "2";

  _module.controller("Camel.SendMessageController", ["$route", "$scope", "$element", "$timeout", "workspace", "jolokia", "localStorage", "$location", "activeMQMessage", "PreferencesLastPath", ($route, $scope, $element, $timeout, workspace:Workspace, jolokia, localStorage, $location, activeMQMessage, PreferencesLastPath) => {
    var log:Logging.Logger = Logger.get("Camel");

    $scope.noCredentials = false;
    $scope.container = {};
    $scope.message = "\n\n\n\n";
    $scope.headers = [];

    // bind model values to search params...
    Core.bindModelToSearchParam($scope, $location, "tab", "subtab", "compose");
    Core.bindModelToSearchParam($scope, $location, "searchText", "q", "");

    // only reload the page if certain search parameters change
    Core.reloadWhenParametersChange($route, $scope, $location);

    $scope.checkCredentials = () => {
      $scope.noCredentials = (Core.isBlank(localStorage['activemqUserName']) || Core.isBlank(localStorage['activemqPassword']));
    };

    if ($location.path().has('activemq')) {
      $scope.localStorage = localStorage;
      $scope.$watch('localStorage.activemqUserName', $scope.checkCredentials);
      $scope.$watch('localStorage.activemqPassword', $scope.checkCredentials);

        //prefill if it's a resent
        if(activeMQMessage.message !== null){
           $scope.message = activeMQMessage.message.bodyText;
           if( activeMQMessage.message.PropertiesText !== null){
               for( var p in activeMQMessage.message.StringProperties){
                   $scope.headers.push({name: p, value: activeMQMessage.message.StringProperties[p]});
               }
           }
        }
        // always reset at the end
        activeMQMessage.message = null;
    }

    $scope.openPrefs = () => {
      PreferencesLastPath.lastPath = $location.path();
      PreferencesLastPath.lastSearch = $location.search();
      $location.path('/preferences').search({'pref': 'ActiveMQ'});
    };

    var LANGUAGE_FORMAT_PREFERENCE = "defaultLanguageFormat";
    var sourceFormat = workspace.getLocalStorage(LANGUAGE_FORMAT_PREFERENCE) || "javascript";

    // TODO Remove this if possible
    $scope.codeMirror = undefined;
    var options = {
      mode: {
        name: sourceFormat
      },
      // Quick hack to get the codeMirror instance.
      onChange: function (codeMirror) {
        if (!$scope.codeMirror) {
          $scope.codeMirror = codeMirror;
        }
      }
    };
    $scope.codeMirrorOptions = CodeEditor.createEditorSettings(options);

    $scope.addHeader = () => {
      $scope.headers.push({name: "", value: ""});

      // lets set the focus to the last header
      if ($element) {
        $timeout(() => {
          var lastHeader = $element.find("input.headerName").last();
          lastHeader.focus();
        }, 100);
      }
    };

    $scope.removeHeader = (header) => {
      $scope.headers = $scope.headers.remove(header);
    };

    $scope.defaultHeaderNames = () => {
      var answer = [];

      function addHeaderSchema(schema) {
        angular.forEach(schema.definitions.headers.properties, (value, name) => {
          answer.push(name);
        });
      }

      if (isJmsEndpoint()) {
        addHeaderSchema(Camel.jmsHeaderSchema);
      }
      if (isCamelEndpoint()) {
        addHeaderSchema(Camel.camelHeaderSchema);
      }
      return answer;
    };


    $scope.$watch('workspace.selection', function () {
      // if the current JMX selection does not support sending messages then lets redirect the page
      workspace.moveIfViewInvalid();
    });

    /* save the sourceFormat in preferences for later
     * Note, this would be controller specific preferences and not the global, overriding, preferences */
      // TODO Use ng-selected="changeSourceFormat()" - Although it seemed to fire multiple times..
    $scope.$watch('codeMirrorOptions.mode.name', function (newValue, oldValue) {
      workspace.setLocalStorage(LANGUAGE_FORMAT_PREFERENCE, newValue)
    });

    var sendWorked = () => {
      $scope.message = "";
      Core.notification("success", "Message sent!");
    };

    $scope.autoFormat = () => {
      setTimeout(() => {
        CodeEditor.autoFormatEditor($scope.codeMirror);
      }, 50);
    };

    $scope.sendMessage = () => {
      var body = $scope.message;
      doSendMessage(body, sendWorked);
    };


    function doSendMessage(body, onSendCompleteFn) {
      var selection = workspace.selection;
      if (selection) {
        var mbean = selection.objectName;
        if (mbean) {
          var headers = null;
          if ($scope.headers.length) {
            headers = {};
            angular.forEach($scope.headers, (object) => {
              var key = object.name;
              if (key) {
                headers[key] = object.value;
              }
            });
            log.info("About to send headers: " + JSON.stringify(headers));
          }

          var callback = Core.onSuccess(onSendCompleteFn);
          if (selection.domain === "org.apache.camel") {
            var target = Camel.getContextAndTargetEndpoint(workspace);
            var uri = target['uri'];
            mbean = target['mbean'];
            if (mbean && uri) {

              // if we are running Camel 2.14 we can check if its possible to send to the endpoint
              var ok = true;
              if (Camel.isCamelVersionEQGT(2, 14, workspace, jolokia)) {
                var reply = jolokia.execute(mbean, "canSendToEndpoint(java.lang.String)", uri);
                if (!reply) {
                  Core.notification("warning", "Camel does not support sending to this endpoint.");
                  ok = false;
                }
              }

              if (ok) {
                if (headers) {
                  jolokia.execute(mbean, "sendBodyAndHeaders(java.lang.String, java.lang.Object, java.util.Map)", uri, body, headers, callback);
                } else {
                  jolokia.execute(mbean, "sendStringBody(java.lang.String, java.lang.String)", uri, body, callback);
                }
              }
            } else {
              if (!mbean) {
                Core.notification("error", "Could not find CamelContext MBean!");
              } else {
                Core.notification("error", "Failed to determine endpoint name!");
              }
              log.debug("Parsed context and endpoint: ", target);
            }
          } else {
            var user = localStorage["activemqUserName"];
            var pwd = localStorage["activemqPassword"];

            // AMQ is sending non persistent by default, so make sure we tell to sent persistent by default
            if (!headers) {
              headers = {};
            }
            if (!headers["JMSDeliveryMode"]) {
              headers["JMSDeliveryMode"] = DELIVERY_PERSISTENT;
            }

            jolokia.execute(mbean, "sendTextMessage(java.util.Map, java.lang.String, java.lang.String, java.lang.String)", headers, body, user, pwd, callback);
          }
        }
      }
    }

    function isCamelEndpoint() {
      // TODO check for the camel or if its an activemq endpoint
      return true;
    }

    function isJmsEndpoint() {
      // TODO check for the jms/activemq endpoint in camel or if its an activemq endpoint
      return true;
    }

  }]);
}
