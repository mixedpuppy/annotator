/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu, manager: Cm} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "NetUtil",
                                  "resource://gre/modules/NetUtil.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Services",
                                  "resource://gre/modules/Services.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PlacesUtils",
                                  "resource://gre/modules/PlacesUtils.jsm");


function promiseSetAnnotation(aURI, savedToList) {
  return new Promise(resolve => {
    // Delaying to catch issues with asynchronous behavior while waiting
    // to implement asynchronous annotations in bug 699844.
    Services.tm.mainThread.dispatch(function() {
      try {
        if (savedToList && savedToList.length > 0) {
          PlacesUtils.annotations.setPageAnnotation(
            aURI, "action/saved", JSON.stringify(savedToList), 0,
            PlacesUtils.annotations.EXPIRE_WITH_HISTORY);
        } else {
          PlacesUtils.annotations.removePageAnnotation(aURI, "action/saved");
        }
      } catch(e) {
        Cu.reportError("Annotation failed: " + e);
      }
      resolve();
    }, Ci.nsIThread.DISPATCH_NORMAL);
  });
}

function promiseGetAnnotation(aURI) {
  return new Promise(resolve => {
    // Delaying to catch issues with asynchronous behavior while waiting
    // to implement asynchronous annotations in bug 699844.
    Services.tm.mainThread.dispatch(function() {
      let val = null;
      try {
        val = PlacesUtils.annotations.getPageAnnotation(aURI, "action/saved");
      } catch (ex) { }

      resolve(val);
    }, Ci.nsIThread.DISPATCH_NORMAL);
  });
}

function addAnnotationEntry(name, url) {
  return new Promise(resolve => {
    let URI = Services.io.newURI(url, null, null);
    // update or set our annotation
    promiseGetAnnotation(URI).then(function(val) {

      let savedToList = val ? JSON.parse(val) : [];
      let saved = savedToList.indexOf(name) >= 0;
      if (saved) {
        resolve(savedToList);
        return;
      }
      savedToList.push(name);

      // make sure there is a history entry for the uri, then annotate it.
      let place = {
        uri: URI,
        visits: [{
          visitDate: Date.now(),
          transitionType: Ci.nsINavHistoryService.TRANSITION_LINK
        }]
      };
      PlacesUtils.asyncHistory.updatePlaces(place, {
        handleError: () => Cu.reportError("couldn't update history for socialmark annotation"),
        handleResult: function () {},
        handleCompletion: function () {
          promiseSetAnnotation(URI, savedToList).then(function() {
            resolve(savedToList);
          }).then(null, Cu.reportError);
        }
      });
    }).then(null, Cu.reportError);
  });
}

function* allBrowserWindows() {
  var winEnum = Services.wm.getEnumerator("navigator:browser");
  while (winEnum.hasMoreElements()) {
    let win = winEnum.getNext();
    // skip closed windows
    if (win.closed)
      continue;
    yield win;
  }
}

let watchedServices = [
  {
    url: "https://www.facebook.com/v2.3/dialog/share/submit",
    name: "facebook",
    getSavedUrl(postData) {
      return JSON.parse(postData.share_action_properties).object;
    }
  },
  {
    url: "https://www.facebook.com/v2.0/dialog/share/submit",
    name: "facebook",
    getSavedUrl(postData) {
      return JSON.parse(postData.share_action_properties).object;
    }
  },
  {
    url: "https://api.getpocket.com/v3/firefox/save",
    name: "pocket",
    getSavedUrl(postData) {
      return postData.url;
    }
  },
  {
    url: "https://twitter.com/intent/tweet",
    name: "twitter",
    getSavedUrl(postData) {
      return postData.url;
    }
  }

];

function match(url) {
  for (let f of watchedServices) {
    if (url.startsWith(f.url)) {
      return f;
    }
  }
}
var httpRequestObserver =
{
  convertToUnicode(text, charset) {
    let conv = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
        .createInstance(Ci.nsIScriptableUnicodeConverter);
    try {
      conv.charset = charset || "UTF-8";
      return conv.ConvertToUnicode(text);
    } catch (ex) {
      return text;
    }
  },
  readAndConvertFromStream(stream, charset) {
    let text = null;
    try {
      text = NetUtil.readInputStreamToString(stream, stream.available());
      return this.convertToUnicode(text, charset);
    } catch (err) {
      return text;
    }
  },
  readPostTextFromRequest(channel, charset) {
    if (!(channel instanceof Ci.nsIUploadChannel))
      return null;
    let stream = channel.uploadStream;

    let isSeekableStream = false;
    if (stream instanceof Ci.nsISeekableStream) {
      isSeekableStream = true;
    }

    let prevOffset;
    if (isSeekableStream) {
      prevOffset = stream.tell();
      stream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
    }

    let text = this.readAndConvertFromStream(stream, charset);

    if (isSeekableStream && prevOffset == 0) {
      stream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
    }
    return text;
  },
  parsePostData(text) {
    if (!text)
      return [];
    if (text.includes("Content-Type: application/json")) {
      text = text.split("\r\n\r\n")[1];
      return JSON.parse(text);
    } else
    if (text.includes("Content-Type: application/x-www-form-urlencoded")) {
      text = text.split("\r\n\r\n")[1];
    }
    let data = {};
    text.split('&').forEach(function (val) {
      let [name, value] = val.split('=');
      data[name] = unescape(value).replace(/[+]/g, " ");
    });
    return data;
  },
  dumpData(topic, subject) {
    let httpChannel = subject.QueryInterface(Ci.nsIHttpChannel);
    let stream = httpChannel.QueryInterface(Components.interfaces.nsIUploadChannel);
    let text = this.readPostTextFromRequest(stream)
    dump(topic+" url: "+httpChannel.originalURI.spec+"\ndata sent: "+text+"\ndata parsed: "+JSON.stringify(this.parsePostData(text))+"\n---\n\n");
  },
  observe(subject, topic, data)
  {
    if (topic == "http-on-modify-request") {
      //this.dumpData(topic, subject);
    } else
    if (topic == "http-on-examine-response") {
      let httpChannel = subject.QueryInterface(Ci.nsIHttpChannel);
      let service = match(httpChannel.originalURI.spec)
      if (service) {
        dump("r: "+service.name+"\n");
        let stream = httpChannel.QueryInterface(Components.interfaces.nsIUploadChannel);
        let text = this.readPostTextFromRequest(stream)
        let postData = this.parsePostData(text);
        dump("shared "+service.getSavedUrl(postData)+"\n");
        let url = service.getSavedUrl(postData);
        addAnnotationEntry(service.name, url).then(savedToList => {
          dump("annotated url in history "+JSON.stringify(savedToList)+"\n");
        })
      } else {
        //this.dumpData(topic, subject);
      }
    }
  }
};

function startup(data, reason) {
  Services.obs.addObserver(httpRequestObserver, "http-on-examine-response", false);
  Services.obs.addObserver(httpRequestObserver, "http-on-modify-request", false);
}

function shutdown(data, reason) {
  // For speed sake, we should only do a shutdown if we're being disabled.
  // On an app shutdown, just let it fade away...
  if (reason == ADDON_DISABLE) {
    Services.obs.removeObserver(httpRequestObserver, "http-on-examine-response", false);
    Services.obs.removeObserver(httpRequestObserver, "http-on-modify-request", false);
  }
}

function install() {
}

function uninstall() {
}
