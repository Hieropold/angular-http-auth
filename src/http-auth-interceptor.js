/*global angular:true, browser:true */

/**
 * @license HTTP Auth Interceptor Module for AngularJS
 * (c) 2012 Witold Szczerba
 * License: MIT
 *
 * Modified by Ilya Kurnosenkov:
 * - handle 400 responses alongside 401 and 403
 * - filter response errors to process only a required subset of errors
 * - intercept requests to add arbitrary auth headers
 * - filter target host to prevent auth header from leaking to unrelated remote hosts
 */
(function () {
  'use strict';

  var responseErrorFilter = function (rejection) {
    return true;
  };

  var requestFilter = function (requestConfig) {
    return false;
  };

  var requestPreprocessor = function (requestConfig) {
    return requestConfig;
  };

  angular.module('http-auth-interceptor', ['http-auth-interceptor-buffer'])

    .factory('authService', ['$rootScope','httpBuffer', function($rootScope, httpBuffer) {
      return {

        /**
         * Call this function to set filter function which will be used to determine
         * if response error should be intercepted. Function will receive rejected response
         * as parameter and must return true (process error) or false (ignore error). By default all response errors
         * will be intercepted.
         */
        setResponseErrorFilter: function (func) {
          responseErrorFilter = func;
        },

        /**
         * Call this function to set filter function which will be used to determine if request should be intercepted.
         * Function will receive request config and should return true to intercept this request and false to ignore it.
         * By default all requests will be ignored ignored.
         * @param func
         */
        setRequestFilter: function (func) {
          requestFilter = func;
        },

        /**
         * Call this function to set a request preprocessor which will be applied to the request if it was not filtered
         * out during requestFilter invocation. This function will receive request config as a parameter and should
         * return changed config or a promise which will be resolved when config will be changed. By default no changes are
         * made to intercepted requests.
         * @param func
         */
        setRequestPreprocessor: function (func) {
          requestPreprocessor = func;
        },

        /**
         * Call this function to indicate that authentication was successfull and trigger a
         * retry of all deferred requests.
         * @param data an optional argument to pass on to $broadcast which may be useful for
         * example if you need to pass through details of the user that was logged in
         * @param configUpdater an optional transformation function that can modify the
         * requests that are retried after having logged in.  This can be used for example
         * to add an authentication token.  It must return the request.
         */
        loginConfirmed: function(data, configUpdater) {
          var updater = configUpdater || function(config) {return config;};
          $rootScope.$broadcast('event:auth-loginConfirmed', data);
          httpBuffer.retryAll(updater);
        },

        /**
         * Call this function to indicate that authentication should not proceed.
         * All deferred requests will be abandoned or rejected (if reason is provided).
         * @param data an optional argument to pass on to $broadcast.
         * @param reason if provided, the requests are rejected; abandoned otherwise.
         */
        loginCancelled: function(data, reason) {
          httpBuffer.rejectAll(reason);
          $rootScope.$broadcast('event:auth-loginCancelled', data);
        }
      };
    }])

    /**
     * $http interceptor.
     * On 400 response (without'ignoreAuthModule' option) stores the request
     * and broadcasts 'event:auth-missingParameter'. Usually this indicates that
     * request is missing access token.
     * On 401 response (without 'ignoreAuthModule' option) stores the request
     * and broadcasts 'event:auth-loginRequired'.
     * On 403 response (without 'ignoreAuthModule' option) discards the request
     * and broadcasts 'event:auth-forbidden'.
     */
    .config(['$httpProvider', function($httpProvider) {
      $httpProvider.interceptors.push(['$rootScope', '$q', 'httpBuffer', function($rootScope, $q, httpBuffer) {
        return {
          request: function (config) {
            // Skip requests which were filtered out
            if (!requestFilter(config)) {
              return config;
            }

            // Preprocess a request (e.g. add Authorization header, etc.)
            return requestPreprocessor(config);
          },

          responseError: function(rejection) {
            // Apply filter
            if (!responseErrorFilter(rejection)) {
              return $q.reject(rejection);
            }

            var config = rejection.config || {};
            if (!config.ignoreAuthModule) {
              switch (rejection.status) {
                case 400:
                  var deferred = $q.defer();
                  httpBuffer.append(config, deferred);
                  $rootScope.$broadcast('event:auth-missingParameter', rejection);
                  return deferred.promise;
                case 401:
                  var deferred = $q.defer();
                  httpBuffer.append(config, deferred);
                  $rootScope.$broadcast('event:auth-loginRequired', rejection);
                  return deferred.promise;
                case 403:
                  $rootScope.$broadcast('event:auth-forbidden', rejection);
                  break;
              }
            }
            // otherwise, default behaviour
            return $q.reject(rejection);
          }
        };
      }]);
    }]);

  /**
   * Private module, a utility, required internally by 'http-auth-interceptor'.
   */
  angular.module('http-auth-interceptor-buffer', [])

    .factory('httpBuffer', ['$injector', function($injector) {
      /** Holds all the requests, so they can be re-requested in future. */
      var buffer = [];

      /** Service initialized later because of circular dependency problem. */
      var $http;

      function retryHttpRequest(config, deferred) {
        function successCallback(response) {
          deferred.resolve(response);
        }
        function errorCallback(response) {
          deferred.reject(response);
        }
        $http = $http || $injector.get('$http');
        $http(config).then(successCallback, errorCallback);
      }

      return {
        /**
         * Appends HTTP request configuration object with deferred response attached to buffer.
         */
        append: function(config, deferred) {
          buffer.push({
            config: config,
            deferred: deferred
          });
        },

        /**
         * Abandon or reject (if reason provided) all the buffered requests.
         */
        rejectAll: function(reason) {
          if (reason) {
            for (var i = 0; i < buffer.length; ++i) {
              buffer[i].deferred.reject(reason);
            }
          }
          buffer = [];
        },

        /**
         * Retries all the buffered requests clears the buffer.
         */
        retryAll: function(updater) {
          for (var i = 0; i < buffer.length; ++i) {
            retryHttpRequest(updater(buffer[i].config), buffer[i].deferred);
          }
          buffer = [];
        }
      };
    }]);
})();
