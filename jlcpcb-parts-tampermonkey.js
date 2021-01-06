// ==UserScript==
// @name         JLCPCB Parts List Improvements
// @namespace    https://poly.nomial.co.uk/
// @homepage     https://github.com/gsuberland/jlcpcb-tampermonkey/
// @downloadURL  https://raw.githubusercontent.com/gsuberland/jlcpcb-tampermonkey/main/jlcpcb-parts-tampermonkey.js
// @version      0.1
// @description  Fetches additional part data from LCSC on JLCPCB's parts list.
// @author       Graham Sutherland (@gsuberland)
// @match        https://jlcpcb.com/parts/*
// @grant        GM_xmlhttpRequest
// @grant        GM_log
// @connect      lcsc.com
// ==/UserScript==

(function() {
    'use strict';

    // set this if you want a bunch of console output for debugging.
    var debugMode = false;

    var currentPartElements = [];
    var currentPartId = null;
    var partCache = {};

    var csrfToken = null;
    var csrfTokenRegex = /'X-CSRF-TOKEN':\s+'([^']+)'/mi;

    // this just uses GM_log to print a debug message, but prefixes string messages with the plugin identifier so you can spot them a little easier
    var logDebugMessage = function(message)
    {
        if (debugMode)
        {
            if (typeof message === 'string')
            {
                GM_log("[JLCPCB Tampermonkey] " + message);
            }
            else
            {
                GM_log(message);
            }
        }
    };

    // pull the CSRF token direct from the LCSC website. the @connect directive in this script allows us to bypass CORS for the LCSC domain.
    var getCSRFToken = function()
    {
        // did we already get the CSRF token?
        if (csrfToken)
        {
            return csrfToken;
        }
        // attempt to get CSRF token via XHR
        GM_xmlhttpRequest({
            "method": "GET",
            "url": "https://lcsc.com/products/",
            "onload": function(results)
            {
                let match = csrfTokenRegex.exec(results.response);
                if (match)
                {
                    csrfToken = match[1];
                    return csrfToken;
                }
                else
                {
                    logDebugMessage("Failed to read CSRF token from LCSC.");
                }
            }
        });
        // if it's been set now, return it.
        if (csrfToken)
        {
            return csrfToken;
        }
    };

    // function to clear out all the part elements we're tracking
    var clearPartElements = function()
    {
        for (let idx in currentPartElements)
        {
            if (currentPartElements[idx].parentNode)
            {
                currentPartElements[idx].parentNode.removeChild(currentPartElements[idx]);
            }
        }
        currentPartElements = [];
    };

    // function to add part attribs to the page
    var updateAttributes = function(partId, attributes, partRowElement)
    {
        // find the element that contains part details
        let detailsElement = partRowElement.querySelector("td > div.pull-left.line40");
        // add all the new attribs to the table
        let newElements = [];
        for (let attribName in attributes)
        {
            let attribRowElement = document.createElement("p");
            attribRowElement.setAttribute("class", "mb0 borderB relative pr20");
            attribRowElement.innerHTML = '<span class="inline w140">' + attribName + '</span><span class="ng-binding">' + attributes[attribName] + '</span><i class="cursor icon-bg icon-copy"><span class="absCopyNotice">_</span></i>';
            detailsElement.appendChild(attribRowElement);
            // keep track of the new elements we're adding
            newElements.push(attribRowElement);
        }
        // clear any old elements
        clearPartElements();
        // set new element list
        currentPartElements = newElements;
    };

    // function to fetch LCSC data (or cached copy) when a new part is selected
    var handlePartSelection = function(partId, partRowElement)
    {
        logDebugMessage("handlePartSelection called: " + partId);

        // check if cached
        if (partCache.hasOwnProperty(partId))
        {
            logDebugMessage("cache hit on part " + partId);
            let partData = partCache[partId];
            updateAttributes(partId, partData.attributes, partRowElement);
            return;
        }

        logDebugMessage("cache miss on part " + partId + ", fetching from LCSC");

        // fetch from LCSC
        GM_xmlhttpRequest({
            "method": "POST",
            "url": "https://lcsc.com/api/products/search",
            "responseType": "json",
            "headers": {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "x-csrf-token": getCSRFToken(),
            },
            "overrideMimeType": "application/x-www-form-urlencoded; charset=UTF-8",
            "data": "search_content=" + partId,
            "context": {
                "partId": partId,
                "partRowElement": partRowElement
            },
            "onload": function(results)
            {
                if (results.response && results.response.code == 200 && results.response.result && results.response.result.data && results.response.result.data.length > 0)
                {
                    let partData = results.response.result.data[0];
                    if (partData.number == partId)
                    {
                        logDebugMessage("Got part data from LCSC.");
                        logDebugMessage(partData);
                        // add to cache
                        partCache[partId] = partData;
                        // update page
                        updateAttributes(partId, partData.attributes, partRowElement);
                    }
                    else
                    {
                        logDebugMessage("Failed to read product " + partId + " - Results did not contain required part. Response:");
                        logDebugMessage(results.response);
                    }
                }
                else
                {
                    logDebugMessage("Failed to read product " + partId + " - HTTP request did not return correct data. Response:");
                    logDebugMessage(results.response);
                }
            }
        });
    };

    var observer = new MutationObserver(function(mutations)
    {
        // check if the user closed a part (also works for switching which part is open), and if so clean up any elements we added for that part
        var mutationsArray = Array.from(mutations);
        if (mutationsArray.some((mut) => Array.from(mut.removedNodes).some((rn) => rn.nodeName == "TR")))
        {
            logDebugMessage("Collapsed part info. Clearing elements.");
            currentPartId = null;
            clearPartElements();
        }
        if (mutationsArray.some((mut) => Array.from(mut.addedNodes).some((rn) => rn.nodeName == "TR")))
        {
            // find the part
            let partLinkElement = document.querySelector("table > tbody > tr > td > div.pull-left.line40 > p > a");
            if (partLinkElement)
            {
                if (partLinkElement.innerText && partLinkElement.innerText != "")
                {
                    var partId = partLinkElement.innerText.trim();
                    if (partId.startsWith("C"))
                    {
                        if (partId != currentPartId)
                        {
                            let partRowElement = partLinkElement.closest("tr");
                            currentPartId = partId;
                            logDebugMessage("New part selected: " + partId);
                            handlePartSelection(partId, partRowElement);
                        }
                    }
                }
            }
            else
            {
                logDebugMessage("Warning: Could not find part link element.");
            }
        }
    });
    observer.observe(document, {subtree: true, attributes: false, childList: true});

    // try to load CSRF token at page load.
    getCSRFToken();
})();
