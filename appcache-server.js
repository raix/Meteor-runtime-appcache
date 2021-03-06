var crypto = Npm.require('crypto');
var fs = Npm.require('fs');
var path = Npm.require('path');

var knownBrowsers = [
  'android',
  'chrome',
  'chromium',
  'chromeMobileIOS',
  'firefox',
  'ie',
  'mobileSafari',
  'safari'
];

var browsersEnabledByDefault = [
  'android',
  'chrome',
  'chromium',
  'chromeMobileIOS',
  'ie',
  'mobileSafari',
  'safari'
];

var enabledBrowsers = {};
_.each(browsersEnabledByDefault, function (browser) {
  enabledBrowsers[browser] = true;
});

// Then runtime bundle contains dynamic file reference to runtime bundles
var runtimeBundle; // {} is initialized if needed

Meteor.AppCache = {
  config: function(options) {
    _.each(options, function (value, option) {
      if (option === 'browsers') {
        enabledBrowsers = {};
        _.each(value, function (browser) {
          enabledBrowsers[browser] = true;
        });
      }
      else if (_.contains(knownBrowsers, option)) {
        enabledBrowsers[option] = value;
      }
      else if (option === 'onlineOnly') {
        _.each(value, function (urlPrefix) {
          RoutePolicy.declare(urlPrefix, 'static-online');
        });
      }
      else {
        throw new Error('Invalid AppCache config option: ' + option);
      }
    });
  },
  addRuntimeBundle: function(url, forceHash) {
    if (url !== ''+url || url === '') {
      throw new Error('Invalid AppCache addRuntimeBundle url');
    }

    if (!runtimeBundle) {
      // Initialize runtime bundle list
      runtimeBundle = {};
    }
    // Add the url to the runtime bundle list
    runtimeBundle[url] = {
      url: url,
      useQueryString: !forceHash
    };
  }
};

var browserEnabled = function(request) {
  return enabledBrowsers[request.browser.name];
};

WebApp.addHtmlAttributeHook(function (request) {
  if (browserEnabled(request))
    return 'manifest="/app.manifest' + ((runtimeBundle)?request.url.search:'') + '"';
  else
    return null;
});

WebApp.connectHandlers.use(function(req, res, next) {
  if (req._parsedUrl.pathname !== '/app.manifest') {
    return next();
  }

  // Browsers will get confused if we unconditionally serve the
  // manifest and then disable the app cache for that browser.  If
  // the app cache had previously been enabled for a browser, it
  // will continue to fetch the manifest as long as it's available,
  // even if we now are not including the manifest attribute in the
  // app HTML.  (Firefox for example will continue to display "this
  // website is asking to store data on your computer for offline
  // use").  Returning a 404 gets the browser to really turn off the
  // app cache.

  if (!browserEnabled(WebApp.categorizeRequest(req))) {
    res.writeHead(404);
    res.end();
    return;
  }

  // After the browser has downloaded the app files from the server and
  // has populated the browser's application cache, the browser will
  // *only* connect to the server and reload the application if the
  // *contents* of the app manifest file has changed.
  //
  // So we have to ensure that if any static client resources change,
  // something changes in the manifest file.  We compute a hash of
  // everything that gets delivered to the client during the initial
  // web page load, and include that hash as a comment in the app
  // manifest.  That way if anything changes, the comment changes, and
  // the browser will reload resources.

  var hash = crypto.createHash('sha1');
  hash.update(JSON.stringify(__meteor_runtime_config__), 'utf8');
  _.each(WebApp.clientProgram.manifest, function (resource) {
    if (resource.where === 'client' || resource.where === 'internal') {
      hash.update(resource.hash);
    }
  });
  var digest = hash.digest('hex');

  var manifest = "CACHE MANIFEST\n\n";
  manifest += '# ' + digest + "\n\n";

  manifest += "CACHE:" + "\n";
  manifest += "/" + "\n";
  _.each(WebApp.clientProgram.manifest, function (resource) {
    if (resource.where === 'client' &&
        ! RoutePolicy.classify(resource.url)) {
      manifest += resource.url;
      // If the resource is not already cacheable (has a query
      // parameter, presumably with a hash or version of some sort),
      // put a version with a hash in the cache.
      //
      // Avoid putting a non-cacheable asset into the cache, otherwise
      // the user can't modify the asset until the cache headers
      // expire.
      if (!resource.cacheable)
        manifest += "?" + resource.hash;

      manifest += "\n";
    }
  });

  _.each(runtimeBundle, function(bundle) {
    // Added hook for dynamic runtime bundles
    // these could be files that should run before or after Meteor
    // or files to lazyload - but still have the offline capabillity
    if (! RoutePolicy.classify(bundle.url)) {
      // We pass on the parametre
      manifest += bundle.url;

      if (bundle.useQueryString && req._parsedUrl.search) {
        // Add the query string
        manifest += req._parsedUrl.search + '\n';
      } else {
        // Generate a pr. bundle hash
        var myHash = crypto.createHash('sha1');
        
        // Generate the file hash based on manifest digest and bundle url
        myHash.update(digest + bundle.url);
        var myDigest = myHash.digest('hex');

        manifest += '?' + myDigest + '\n';
      }
    }
  });
  manifest += "\n";

  manifest += "FALLBACK:\n";
  manifest += "/ /" + "\n";
  // Add a fallback entry for each uncacheable asset we added above.
  //
  // This means requests for the bare url (/image.png instead of
  // /image.png?hash) will work offline. Online, however, the browser
  // will send a request to the server. Users can remove this extra
  // request to the server and have the asset served from cache by
  // specifying the full URL with hash in their code (manually, with
  // some sort of URL rewriting helper)
  _.each(WebApp.clientProgram.manifest, function (resource) {
    if (resource.where === 'client' &&
        ! RoutePolicy.classify(resource.url) &&
        !resource.cacheable) {
      manifest += resource.url + " " + resource.url +
        "?" + resource.hash + "\n";
    }
  });

  manifest += "\n";

  manifest += "NETWORK:\n";
  // TODO adding the manifest file to NETWORK should be unnecessary?
  // Want more testing to be sure.
  manifest += "/app.manifest" + ((runtimeBundle)?req._parsedUrl.search:'') + "\n";
  _.each(
    [].concat(
      RoutePolicy.urlPrefixesFor('network'),
      RoutePolicy.urlPrefixesFor('static-online')
    ),
    function (urlPrefix) {
      manifest += urlPrefix + "\n";
    }
  );
  manifest += "*" + "\n";

  // content length needs to be based on bytes
  var body = new Buffer(manifest);

  res.setHeader('Content-Type', 'text/cache-manifest');
  res.setHeader('Content-Length', body.length);
  return res.end(body);
});

var sizeCheck = function() {
  var totalSize = 0;
  _.each(WebApp.clientProgram.manifest, function (resource) {
    if (resource.where === 'client') {
      totalSize += resource.size;
    }
  });
  if (totalSize > 5 * 1024 * 1024) {
    Meteor._debug(
      "** You are using the appcache package but the total size of the\n" +
      "** cached resources is " +
      (totalSize / 1024 / 1024).toFixed(1) + "MB.\n" +
      "**\n" +
      "** This is over the recommended maximum of 5 MB and may break your\n" +
      "** app in some browsers! See http://docs.meteor.com/#appcache\n" +
      "** for more information and fixes.\n"
    );
  }
};

sizeCheck();
