'use strict';


/*
 * Worker for getting favicons in background, and populating the sidebar bookmarks table
 * and saved storage with an URI (data:....) to keep them in self contained form
 * and not fetch them on Internet permanently (performance ..)
 */


/*
 * Constants
 */
const Hysteresis = 60000; // Wait time in milliseconds before starting fetch favicon
						  // after add-on start.
const Cadence = 200; // Wait time in milliseconds between a request completion
                     // and start next one in queue
const FetchTimeout = 30000; // Wait time in milliseconds for a fetch URL to complete
const FReader = new FileReader();


/*
 *  Global variables
 */
let hysteresis = Cadence;
let requestTimerID; // Hold current reference to timer if there is one active
let fetchController = null;
let reqQueue = []; // Array of input requests, to serialize and cadence their handling
//let xmlHttpReq; // XMLHttpRequest
let fetchTimerID = null;


/*
 * Functions
 * ---------
 */

/*
 * Send back to main thread the URI, and redispatch if more in the queue
 * 
 * bnId = Id of BookmarkNode
 * uri is a String
 */
function answerBack (bnId, uri) {
//  console.log("Answering [BN.id="+BN.id+",uri=<<"+uri.substr(0,40)+">>]");
//  postMessage([bnId, uri]);
  try { // Ensure we always come back here even if there is a problem in called code
	    // in order to restart timer and continue dequeueing, or clear timer as needed.
	asyncFavicon({data: [bnId, uri]});
  }
  catch (err) {
	let msg = "Error in favicon call to asyncFavicon() : "+err;
	console.log(msg);
	console.log("lineNumber: "+err.lineNumber);
	console.log("fileName:   "+err.fileName);
  }

  if (uri != "starting:") {
	reqQueue.shift(); // Remove the element in queue we just processed (= first one)
	if (reqQueue.length > 0) { // Still work in reqQueue, continue the cadence process
//      console.log("Still work in queue: "+reqQueue.length+" - redispatching");
	  requestTimerID = setTimeout(handleRequest, hysteresis);
	}
	else {
	  requestTimerID = undefined; // No more request running and scheduled for now
	}
  }
}

/*
 * Global object to read URI encoded contents of blob and send back to main thread 
 */
let readerBNId; // Id of BookmarkNode on which is the URI 
function readerLoad () {
  answerBack(readerBNId, FReader.result);
}

/*
 * Function to handle a timeout on fetch() request: abort it 
 */
function fetchTimeoutHandler () {
//  console.log("timeout");
  fetchTimerID = null;
  fetchController.abort();
}

/*
 * Retrieve the favicon, and transform it to a data: uri
 * 
 * BN is a BookmarkNode
 * url is a String
 */
const MyInitFF56 = {
  credentials: "omit",
  mode: "cors",
  redirect: "follow"
};
const MyInitFF57 = {
  credentials: "omit",
  mode: "cors",
  redirect: "follow",
  signal: null
};

/*
 * Fetch URI of a favicon
 * 
 * bnId = Id of BookmarkNode
 * url = URL string
 * enableCookies = a Boolean to "omit" (false) or "include" (true)
 */
function getUri (bnId, url, enableCookies) {
//  console.log("Getting favicon contents from "+url);
  // Need to recreate the AbortController each time, or else all requests after
  // an abort will abort .. and there appears to be no way to remove / clear the abort signal
  // from the AbortController.
  try { // Only supported as of FF 57
    fetchController = new AbortController();
  }
  catch (error) {
    console.log("getUri error: "+error);
  }
  let myInit;
  if (fetchController == null) { // we are below FF 57
    myInit = MyInitFF56;
  }
  else {
    myInit = MyInitFF57;
    let fetchSignal = fetchController.signal;
    myInit.signal = fetchSignal;
  }
  myInit.credentials = (enableCookies ? "include" : "omit");
  fetch(url, myInit)
  .then(
    function (response) { // This is a Response object 
      // Remove fetch timeout
      clearTimeout(fetchTimerID);
      fetchTimerID = null;
//      console.log("Status: "+response.status+"'for url: "+url);
      if (response.status == 200) { // If ok, get contents as blob
        response.blob()
        .then(
          function (blob) { // blob is a Blob ..
//            console.log("Contents: "+blob);
            readerBNId = bnId;
   	        FReader.readAsDataURL(blob);
          }
   	    )
   	    .catch( // Asynchronous also, like .then
   	      function (err) {
   	    	let msg = "Response.blob Error :-S "+err;
   	    	console.log(msg, url);
   	    	console.log("lineNumber: "+err.lineNumber);
   	    	console.log("fileName:   "+err.fileName);
   	    	answerBack(bnId, "error: "+msg);
   	      }
   	    );
      }
      else {
    	let msg = "error: Looks like there was a URL fetch problem. Status Code: "+response.status;
        console.log(msg+" url: "+url);
        answerBack(bnId, msg+"\r\n"
                       +"Full text: "+response.statusText);
      }
    }
  )
  .catch( // Asynchronous also, like .then
    function (err) {
      // Remove fetch timeout
      if (fetchTimerID != null) {
    	clearTimeout(fetchTimerID);
    	fetchTimerID = null;
      }
      let msg = "Favicon fetch Error :-S "+err;
      console.log(msg, url);
      answerBack(bnId, "error: "+msg);
    }
  );

  // Set timeout on fetch
  fetchTimerID = setTimeout(fetchTimeoutHandler, FetchTimeout);
}

/*
 * Parse relative to position index to retrieve "href=\"" around,
 * and within limits of '<' and '>' on left and right, and then
 * get the text between the two '\"'.
 * 
 * lctext is a lower case version of the HTML document string
 * text is the original HTML document string
 * pos is the position in both from where to search
 * token is a string describing the HTML <token> to search for. E.g. "link", "base", ..
 */
const PatternCheckLink = /^<\s*link\s/;
const PatternHref2 = /href\s*=\s*\"/;
const PatternHref2b = /href\s*=\s*\'/;
const PatternHref2c = /href\s*=\S/;
const PatternHref3 = /^\S+/;
let glob_lctext;
function retrieveHref (text, pos, searchLinkToken = false) {
  let faviconUrl;

  // Find enclosing brackets
  let posStart = glob_lctext.lastIndexOf("<", pos); // Search left starting from pos included
  let posEnd = glob_lctext.indexOf(">", pos);
  if ((posStart < 0) || (posEnd < 0))
    return(null); // Not found
  let extract = glob_lctext.slice(posStart, posEnd); // Warning, last char '>' not included

  if (searchLinkToken // Verify this is a <link>
      && (extract.search(PatternCheckLink) < 0)
     ) {
    return(null); // Not found
  }

  // Looks good so far, let's find the href string
  let isDoubleQuote = true;
  let isNoQuote = false;
  let a_href = extract.match(PatternHref2);
  // See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/match
  // for format of the return value of match()
  if (a_href == null) {
	a_href = extract.match(PatternHref2b);
	if (a_href == null) {
      a_href = extract.match(PatternHref2c);
	  if (a_href == null) {
	    return(null); // Not found
	  }
	  isNoQuote = true;
	}
	isDoubleQuote = false;
  }

  // Found something, let's find the end of it
  let posStartQuote = a_href.index + a_href[0].length;
  let posEndQuote;
  if (isNoQuote) {
	posStartQuote--; // Include the first non-space character at end, just after =
	// End = first blank or end of string
	let rest = extract.slice(posStartQuote);
	a_href = rest.match(PatternHref3);
    posEndQuote = posStartQuote + a_href[0].length;
  }
  else {
	posEndQuote = extract.indexOf((isDoubleQuote ? "\"" : "\'"),
                                  posStartQuote);
  }
  if (posEndQuote < 0) // We were so close :-(
    return(null); // Not found

  // Get the value with corrent Caps and lower case mix, and return it
  faviconUrl = text.slice(posStart+posStartQuote, posStart+posEndQuote);
  
  return(faviconUrl);
}

/*
 * Parse the page HTML to retrieve a base URL and return it.
 * Could use a DOMParser, that would surely be the most complete method ..
 * however this can be an heavy process, so trying first with some basic string searches.
 * If success rate is not high, will revert to that higher demanding process.
 * 
 * (Also, not sure at this stage that a DOMParser can run in a worker ..
 *  For sure, XMLHttpRequest.responseXML() is not available to Workers
 *  cf. https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest)
 *  
 *  text is an HTML document string
 *  lctext is the same, but in lowercase
 */
const PatternBase = /<\s*base\s/;
function retrieveBaseUrl (text) {
  let baseUrl = null;

  // Search for "/<\s*base\s/"
  // (see https://superuser.com/questions/157925/how-to-download-favicon-from-website
  //      https://stackoverflow.com/questions/1990475/how-can-i-retrieve-the-favicon-of-a-website
  //      https://stackoverflow.com/questions/5119041/how-can-i-get-a-web-sites-favicon
  let pos = glob_lctext.search(PatternBase);
  if (pos >= 0) { // Found a candidate, then search for the href piece ..
	baseUrl = retrieveHref(text, pos);
  }

  return(baseUrl);
}

/*
 * Parse the page HTML to retrieve a favicon URL and return it.
 * Could use a DOMParser, that would surely be the most complete method ..
 * however this can be an heavy process, so trying first with some basic string searches.
 * If success rate is not high, will revert to that higher demanding process.
 * 
 * (Also, not sure at this stage that a DOMParser can run in a worker ..
 *  For sure, XMLHttpRequest.responseXML() is not available to Workers
 *  cf. https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest)
 *  
 *  text is an HTML document string
 *  lctext is the same, but in lowercase
 */
const PatternFavicon1 = /rel\s*=\s*\"shortcut icon\"/; // Not to be used anymore per standard,
                                                       // but a lot of sites still use it, and Firefox
                                                       // still appears to give preference to this one ...
const PatternFavicon1b = /rel\s*=\s*\'shortcut icon\'/;
const PatternFavicon2 = /rel\s*=\s*\"icon\"/;
const PatternFavicon2b = /rel\s*=\s*\'icon\'/;
function retrieveFaviconUrl (text) {
  let faviconUrl = null;

  // First, search for "rel=\"shortcut icon\""
  // (see https://superuser.com/questions/157925/how-to-download-favicon-from-website
  //      https://stackoverflow.com/questions/1990475/how-can-i-retrieve-the-favicon-of-a-website
  //      https://stackoverflow.com/questions/5119041/how-can-i-get-a-web-sites-favicon
  let pos = glob_lctext.search(PatternFavicon1);
  if (pos >= 0) { // Found a candidate, then search for the href piece ..
    faviconUrl = retrieveHref(text, pos, true);
  }
  if (faviconUrl == null) { // Not yet found
    pos = glob_lctext.search(PatternFavicon1b);
    if (pos >= 0) { // Found a candidate, then search for the href piece ..
      faviconUrl = retrieveHref(text, pos, true);
    }
  }
  if (faviconUrl == null) { // Not yet found
    pos = glob_lctext.search(PatternFavicon2);
    if (pos >= 0) { // Found a candidate, then search for the href piece ..
      faviconUrl = retrieveHref(text, pos, true);
    }
  }
  if (faviconUrl == null) { // Not yet found
    pos = glob_lctext.search(PatternFavicon2b);
    if (pos >= 0) { // Found a candidate, then search for the href piece ..
      faviconUrl = retrieveHref(text, pos, true);
    }
  }

  return(faviconUrl);
}

/*
 * Fetch favicon, and then get its URI
 * 
 * bnId = Id of BookmarkNode
 * bnUrl = URL string
 * myInit = fetch parameters
 * enableCookies = a Boolean to "omit" (false) or "include" (true)
 */
function fetchFavicon (bnId, bnUrl, enableCookies) {
  // Need to recreate the AbortController each time, or else all requests after
  // an abort will abort .. and there appears to be no way to remove / clear the abort signal
  // from the AbortController.
  try { // Only supported as of FF 57
    fetchController = new AbortController();
  }
  catch (error) {
    console.log("handleRequest error: "+error);
  }
  let myInit;
  if (fetchController == null) { // we are below FF 57
    myInit = MyInitFF56;
  }
  else {
    myInit = MyInitFF57;
    let fetchSignal = fetchController.signal;
    myInit.signal = fetchSignal;
  }
  myInit.credentials = (enableCookies ? "include" : "omit");
  fetch(bnUrl, myInit)
  .then(
	function (response) { // response is a Response object
//      console.log("response");
	  // Remove fetch timeout
	  clearTimeout(fetchTimerID);
	  fetchTimerID = null;
//      console.log("Status: "+response.status);
	  // Some errors return a page with a favicon, when the site implements a proper error page
	  //if (response.status == 200) { // If ok, get contents as a string
	    response.text()
	    .then(
	  	  function (text) { // text is a USVString returned by Response.text()
//			  console.log("Got text");
//			  console.log("Contents: "+text.substr(0,5000));
	  	   	glob_lctext = text.toLowerCase(); // Avoid getting lost because of Caps ...
	        let faviconUrl = retrieveFaviconUrl(text);
//			  console.log("faviconUrl 1: <<"+faviconUrl+">>");

			if (faviconUrl == null) { // If not found, try the old root/favicon.ico method
			  let urlObj = new URL (response.url); // Use the URL of response in case
			                                       // we were redirected ..
			  faviconUrl = urlObj.origin + "/favicon.ico";
//				console.log("faviconUrl 2: <<"+faviconUrl+">>");
//			  URL.revokeObjectURL(urlObj);
			  urlObj = undefined;
			  getUri(bnId, faviconUrl, enableCookies);
			}
			else if (faviconUrl.startsWith("data:")) { // Cool, it is already a self contained piece ..
//				console.log("Got it directly !");
			  answerBack(bnId, faviconUrl);
			}
			else if (!faviconUrl.startsWith("http")) { // Not an absolute URL, make it absolute
			  let urlObj = new URL (response.url); // Use the URL of response in case
			                                       // we were redirected ..
			  if (faviconUrl.startsWith("//")) { // Scheme (protocol, e.g. https:) relative URL
			    faviconUrl = urlObj.protocol + faviconUrl;
			  }
			  else if (faviconUrl.charAt(0) == '/') { // Root relative URL
			    // Verify if there is a <base href=..> tag
			    let baseUrl = retrieveBaseUrl(text);
//				  console.log("baseUrl 1: <<"+baseUrl+">>");
			    if ((baseUrl != null) && (baseUrl.includes("://"))) {
//			      URL.revokeObjectURL(urlObj);
			      urlObj = new URL (baseUrl);
			    }
			    faviconUrl = urlObj.origin + faviconUrl;
			  }
			  else { // Just relative URL ...
			         // Verify if there is a <base href=..> tag
			    let baseUrl = retrieveBaseUrl(text);
//				  console.log("baseUrl 2: <<"+baseUrl+">>");
			    if (baseUrl != null) {
			      if (baseUrl.includes("://"))
			        faviconUrl = baseUrl + faviconUrl;
			      else
			    	faviconUrl = urlObj.origin + baseUrl + faviconUrl;
			    }
			    else {
			      // Need to get back to closest '/' from end of path, removing all
			      //  ?xxx=yy and other stuff
			      let temp = urlObj.origin + urlObj.pathname
			      let pos = temp.lastIndexOf("/");
			      faviconUrl = temp.slice(0, pos+1) + faviconUrl;
			    }
			  }
//		      URL.revokeObjectURL(urlObj);
			  urlObj = undefined;
//				console.log("faviconUrl 3: <<"+faviconUrl+">>");
			  getUri(bnId, faviconUrl, enableCookies);
			}
			else { // Absolute URL
//				console.log("faviconUrl 4: <<"+faviconUrl+">>");
			  getUri(bnId, faviconUrl, enableCookies);
			}
		  }
		)
		.catch( // Asynchronous, like .then
		  function (err) {
			let msg = "Error on loading from local storage : "+err;
			console.log(msg);
			console.log("lineNumber: "+err.lineNumber);
			console.log("fileName:   "+err.fileName);
			answerBack(bnId, "error: "+msg);
		  }
		);
/*      }
	  else {
    	let msg = "error: Looks like there was a page fetch problem. Status Code: "+response.status;
	    console.log(msg+" url: "+bnUrl);
	    console.log(response.statusText);
	    answerBack(BN, msg+"\r\n"
	                   +"Full text: "+response.statusText);
	  }
*/
	}
  )
  .catch( // Asynchronous, like .then
	function pageFetchError (err) {
	  // Remove fetch timeout
      if (fetchTimerID != null) {
    	clearTimeout(fetchTimerID);
    	fetchTimerID = null;
      }
	  let msg = "Page fetch Error :-S "+err;
	  console.log(msg, bnUrl);
	  console.log("lineNumber: "+err.lineNumber);
	  console.log("fileName:   "+err.fileName);
	  answerBack(bnId, "error: "+msg);
	}
  );

  // Set timeout on fetch
  fetchTimerID = setTimeout(fetchTimeoutHandler, FetchTimeout);
}

/*
 * Dequeue a request and process it.
 * Then re-dispatch itself if more work, after <cadence> milliseconds delay
 */
function handleRequest () {
  hysteresis = Cadence; // Hysteresis is a one shot only thing, for the first fetch of massive load,
                        // so now reset to default.
  let request = reqQueue[0]; // This is [action, BN, enableCookies], with:
                             //
                             // action = a string, either "get" or "icon:<url>"
                             // bnId = Id of a BookmarkNode of type "bookmark"
                             // bnUrl = url of page ("get" & "get2") or of favicon ("icon")
                             // enableCookies = a Boolean to "omit" (false) or "include" (true)
                             //   cookies info chen getting favicon. Drawback = user/pwd prompts
                             //   on some sites.
  let action        = request[0];
  let bnId          = request[1];
  let bnUrl         = request[2];
  let enableCookies = request[3];
//  console.log("Dequeued request action: "+action);
  if (bnId != undefined) { // Protect against too many redispatch events 
//    console.log("Dequeued request action: "+action+" BN.id: "+BN.id+" url: "+bnUrl+" remains: "+reqQueue.length);
	if (bnUrl.startsWith("ftp:")) {
	  answerBack(bnId, "/icons/ftpfavicon.png");
	}
	else if (action == "icon") { // We already got the favicon URL (e.g. tab refresh)
		                         // so simply get it.
//      console.log("faviconUrl: <<"+action.slice(5)+">> 2");
	  // In case we get the icon directly, this is on updated tab .. let's not remove the previous favicon
	  // to leave a chance to detect this is the same and to not do massive favicon saves when doing
	  // History -> Restore previous session
	  //answerBack(bnId, "starting:"); // Signal we are starting to retrieve favicon for that BN
	  getUri(bnId, bnUrl, enableCookies);
	}
	else { // Normal get process
	  answerBack(bnId, "starting:"); // Signal we are starting to retrieve favicon for that BN
      // This requires the "<all_urls>" permission in manifest.json
      // Get the page at bookmarked URL, following redirections,
	  // and attempt to retrieve the favicon URL

//      console.log("Fetching: "+bnUrl);
	  fetchFavicon(bnId, bnUrl, enableCookies);

//      console.log("Finished sending request "+fetchTimerID);
    }
  }
}

/*
 * Enqueue a request for processing, and trigger processing if needed.
 */
//Set up internal queueing for posted messages from main thread
//let nbBN = 0;
//let nbBNmin = 0;
//let nbBNmax = nbBNmin + 100;
function faviconWorkerPostMessage (e) { // e is of type MessageEvent,
  // and its data contains [action, bnId, url, enableCookies], with:
  //
  // action = a string, either "get", "get2", "icon", "hysteresis" or "nohysteresis"
  // bnId = Id of a BookmarkNode of type "bookmark"
  // bnUrl = url of page ("get" & "get2") or of favicon ("icon")
  // enableCookies = a Boolean to "omit" (false) or "include" (true)
  //   cookies info chen getting favicon. Drawback = user/pwd prompts
  //   on some sites when true.
// Cannot use the browser.bookmarks interface from within the worker ...
  let data = e.data;
  let action = data[0];
  if (action == "hysteresis") { // Next shot due to a bookmark create or an initial massive load
                                // request will wait for Hysteresis time before really starting.
//    console.log("Hysteresis");
	hysteresis = Hysteresis;
  }
  else if (action == "nohysteresis") { // Remove the hysteresis now if nothing is scheduled,
	                                   // else it will be naturally reset when the handler runs
//    console.log("Remove Hysteresis");
	if (requestTimerID == undefined) {
	  hysteresis = Cadence;
	}
  }
  else if (action == "stopfetching") { // Stop all process and empty the queue
	if (requestTimerID != undefined) { // A request is scheduled with Hysteresis
	  clearTimeout(requestTimerID);
	  requestTimerID = undefined; // It will get rescheduled on next request submitted
	}
	reqQueue.length = 0; // No more request
  }
  else {
	if (action == "get2") { // If this is a manual refresh favicon request, or an existing bookmark,
	  						// put the request at front of the queue, and reset hysteresis to
	  						// normal Cadence value.
	  						// This will make it process immediately, or just after the current
	  						// ongoing one if there is.
//      console.log("Manual triggered fetch");
	  if (hysteresis == Hysteresis) { // Reset hysteresis if there was one, we are accelerating
		hysteresis = Cadence;
		if (requestTimerID != undefined) { // A request is scheduled with Hysteresis
		  clearTimeout(requestTimerID);
		  requestTimerID = undefined; // It will get rescheduled a few lines below with the new Cadence
		}
	  }
	  reqQueue.unshift(data); // Add new request at beginning
	}
	else {
//      if (((nbBN >= nbBNmin) && (nbBN < nbBNmax)) || e.data[0].startsWith("icon:") || e.data[0].startsWith("get2")) {
	  reqQueue.push(data); // Add new request at end
	}
	if (requestTimerID == undefined) { // No cadence process already running, start it
//      console.log("There was no work in queue: "+reqQueue.length+" - dispatching");
	  requestTimerID = setTimeout(handleRequest, hysteresis);
	}
  }
//    let BN = data[1];
//    console.log("Finished queueing request "+data[0]+" for BN.id: "+BN.id+" url: "+BN.url+" Queue length: "+reqQueue.length);
//  }
//  nbBN++;
}


/*
 * Main code:
 * ----------
*/
// Set up final structure for URI conversion
FReader.addEventListener("load", readerLoad);

//onmessage = faviconWorkerPostMessage;