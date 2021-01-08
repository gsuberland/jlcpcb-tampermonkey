// ==UserScript==
// @name         JLCPCB stock check for LCSC
// @namespace    https://poly.nomial.co.uk/
// @version      0.1
// @description  Fetches additional part data from LCSC on JLCPCB's parts list.
// @homepage     https://github.com/gsuberland/jlcpcb-tampermonkey/
// @downloadURL  https://raw.githubusercontent.com/gsuberland/jlcpcb-tampermonkey/main/lcsc-jlpcb-stock-check.js
// @author       Graham Sutherland (@gsuberland)
// @match        https://lcsc.com/products/*
// @match        https://lcsc.com/search?*
// @grant        GM_xmlhttpRequest
// @grant        GM_log
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      jlcpcb.com
// ==/UserScript==

(function() {
    'use strict';

    // set this if you want a bunch of console output for debugging.
    var debugMode = false;

    var pageConsts = {
        "jlcpcbCellSelector": "td[data-jlcpcb-element-type=cell]",
        "productTableContainerId": "product_table_list",
        "productTableBodyId": "table_content",
        "productTableRowSelector": "#table_content > tr",
        "mfrPartColumnHeaderSelector": "#product_table_list > div.product-list-area > table > thead > tr > th.th-mpn",
        "mfrPartFloatingColumnHeaderSelector": "#product_table_list > div.float-table-header > div > table > thead > tr > th.th-mpn",
        "mfrPartCellSelector": "td > div.template-mpn",
        "productPartNumberSelector": "td > div.template-lcsc-num > a",
    };

    var trackedPageElements = [];
    var columnSettings = {
        "stock": {
            "headerText": "JLCPCB Stock",
            "headerElementSettingsKey": "stockHeader",
            "cellElementSettingsKey": "stockCell",
        },
        "price": {
            "headerText": "JLCPCB Price",
            "headerElementSettingsKey": "priceHeader",
            "cellElementSettingsKey": "priceCell",
        }
    };
    var elementSettings = {
        "all": {
            "attribs": {
                "data-jlcpcb-element": "yes",
            },
            "classes": []
        },
        "stockHeader": {
            "id": "jlcpcb_stock_header_cell",
            "float_id": "jlcpcb_floating_stock_header_cell",
            "attribs": {
                "style": "min-width: auto",
                "data-jlcpcb-element-type": "header",
                "data-jlcpcb-element-column": "stock",
            },
            "classes": [ "fixed-th" ]
        },
        "stockCell": {
            "attribs": {
                "data-jlcpcb-element-type": "cell",
                "data-jlcpcb-element-column": "stock",
            },
            "classes": [ "normal-col-td" ],
            "handler": (cell) => stockCellHandler(cell),
            "stockNumElementSelector": "div > div > div > div.avali-stock-num",
        },
        "priceHeader": {
            "id": "jlcpcb_price_header_cell",
            "float_id": "jlcpcb_floating_price_header_cell",
            "attribs": {
                "style": "min-width: auto",
                "data-jlcpcb-element-type": "header",
                "data-jlcpcb-element-column": "price",
            },
            "classes": [ "fixed-th" ]
        },
        "priceCell": {
            "attribs": {
                "data-jlcpcb-element-type": "cell",
                "data-jlcpcb-element-column": "price",
            },
            "classes": [ "normal-col-td" ],
            "handler": (cell) => priceCellHandler(cell),
            "priceElementSelector": "div > div > div > div.avali-stock-num",
        },
    };

    class JLCPCB
    {
        constructor()
        {
            this.cache = {};
            this.cacheDirty = false;
            this.cachePeriod = 1000 * 60 * 60 * 24 * 1; /* 1 day */
            this.pendingPromises = {};
            this.saveInterval = setInterval(function() { JLCPCB.API.saveCache(); }, 1000);
        }

        saveCache()
        {
            if (this.cacheDirty)
            {
                GM_log("[JLCPCB Stock Tampermonkey] Saved cache to persistent storage.");
                GM_setValue("JLCPCB.Cache", this.cache);
                this.cacheDirty = false;
            }
        }

        loadCache()
        {
            this.cache = GM_getValue("JLCPCB.Cache", {});
            this.cacheDirty = false;
            let prevPartCount = Object.keys(this.cache).length;
            GM_log("[JLCPCB Stock Tampermonkey] Loaded " + prevPartCount + " parts from persistent cache.");
            //GM_log(this.cache);
            for (let id in this.cache)
            {
                let cacheAge = Date.now() - this.cache[id].time;
                if (cacheAge > this.cachePeriod)
                {
                    GM_log("[JLCPCB Stock Tampermonkey] Evicting part " + this.cache[id].id + " from persistent cache as it is " + (cacheAge / (1000 * 60 * 60 * 24)).toFixed(2) + " days old.");
                    delete this.cache[id];
                    return false;
                }
            }
            let currentPartCount = Object.keys(this.cache).length;
            let evictedCount = prevPartCount - currentPartCount;
            if (evictedCount > 0)
            {
                GM_log("[JLCPCB Stock Tampermonkey] Evicted " + evictedCount + " expired parts from cache. There are now " + currentPartCount + " parts in the cache.");
                this.cacheDirty = true;
            }
        }

        addToCache(id, part)
        {
            this.cache[id] = {
                "id": id,
                "part": part,
                "time": Date.now(),
            };
            this.cacheDirty = true;
        }

        getFromCache(id)
        {
            if (this.cache.hasOwnProperty(id))
            {
                let cacheAge = Date.now() - this.cache[id].time;
                if (cacheAge > this.cachePeriod)
                {
                    GM_log("[JLCPCB Stock Tampermonkey] Evicting part " + this.cache[id].id + " from persistent cache as it is " + (cacheAge / (1000 * 60 * 60 * 24)).toFixed(2) + " days old.");
                    delete this.cache[id];
                    return false;
                }
                return this.cache[id].part;
            }
            return false;
        }

        getPartInfo(partId)
        {
            let cachedPart = this.getFromCache(partId);
            if (cachedPart !== false)
            {
                return new Promise((resolve, reject) => { resolve(cachedPart) });
            }
            if (this.pendingPromises.hasOwnProperty(partId))
            {
                return this.pendingPromises[partId];
            }

            logDebugMessage("getStock called with " + partId);
            let xhrOpt = {
                "method": "GET",
                "url": "https://jlcpcb.com/shoppingCart/smtGood/getComponentDetail?componentCode=" + partId,
                "responseType": "json",
                /*"headers": {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest",
                },
                "overrideMimeType": "application/x-www-form-urlencoded; charset=UTF-8",*/
                "context": {
                    "partId": partId,
                },
            };

            var promise = new Promise((resolve, reject) => {
                xhrOpt.onload = resolve;
                xhrOpt.onerror = xhrOpt.ontimeout = reject;
                GM_xmlhttpRequest(xhrOpt);
            }).then(
                /* success */
                function(results) {
                    try
                    {
                        if (results.response && results.response.code == 200 && results.response.data)
                        {
                            let partData = results.response.data;
                            if (partData.componentCode == results.context.partId)
                            {
                                logDebugMessage("Got part data from JLCPCB.");
                                logDebugMessage(partData);
                                // add to cache
                                JLCPCB.API.addToCache(results.context.partId, partData);
                                return partData;
                            }
                            else
                            {
                                logDebugMessage("Failed to read product " + results.context.partId + " - Results were returned, but they did not contain required part. Response:");
                                logDebugMessage(results.response);
                            }
                        }
                        else if (results.response && results.response.code == 500)
                        {
                            // part not found
                            logDebugMessage("Part not found on JLCPCB: " + results.context.partId);
                            // cache the part not being found, so we don't just keep sending requests for non-existent parts
                            JLCPCB.API.addToCache(results.context.partId, null);
                            return null;
                        }
                        else
                        {
                            logDebugMessage("Failed to read product " + results.context.partId + " - HTTP request did not return correct data. Response:");
                            logDebugMessage(results.response);
                        }
                    }
                    catch(err) {
                        throw err;
                    }
                    finally {
                        delete JLCPCB.API.pendingPromises[results.context.partId];
                    }
                },
                /* error */
                function(results)
                {
                    logDebugMessage("Failed to read product " + results.context.partId + " - HTTP error. Results:");
                    logDebugMessage(results);
                    // remove the pending promise
                    delete JLCPCB.API.pendingPromises[results.context.partId];
                }
            );
            JLCPCB.API.pendingPromises[partId] = promise;
            return promise;
        }

        static API = new JLCPCB();
    }

    // this just uses GM_log to print a debug message, but prefixes string messages with the plugin identifier so you can spot them a little easier
    var logDebugMessage = function(message)
    {
        if (debugMode)
        {
            if (typeof message === 'string')
            {
                GM_log("[JLCPCB Stock Tampermonkey] " + message);
            }
            else
            {
                GM_log(message);
            }
        }
    };

    var trackPageElement = function(element, type)
    {
        if (!element)
        {
            logDebugMessage("Error: trackPageElement called with null element.");
            return;
        }
        trackedPageElements.push({"type": type, "element": element});
    };

    var destroyPageElement = function(element)
    {
        if (!element)
        {
            logDebugMessage("Error: destroyPageElement called with null element.");
            return;
        }

        let elementIdx = trackedPageElements.findIndex((el) => el.element === element);
        if (elementIdx < 0)
        {
            logDebugMessage("Warning: destroyPageElement called with untracked element.");
        }
        else
        {
            trackedPageElements.splice(elementIdx, 1);
        }

        if (element.parentNode)
        {
            element.parentNode.removeChild(element);
        }
        else
        {
            logDebugMessage("Warning: destroyPageElement called with element that has no parent.");
        }
    };

    var destroyPageElementsOfType = function(type)
    {
        while (true)
        {
            let elementIdx = trackedPageElements.findIndex((el) => el.type == type);
            if (elementIdx < 0)
            {
                return;
            }
            destroyPageElement(trackedPageElements[elementIdx].element);
        }
    };

    var createPageElement = function(tag, settingsKey, overrideSettings)
    {
        let newElement = document.createElement(tag);
        // start with some default element properties (from the element settings "all" key)
        let elementId = null;
        let elementAttribs = elementSettings.all.attribs;
        let elementClasses = elementSettings.all.classes;
        if (settingsKey)
        {
            // apply attribute to specify which settings key was used
            newElement.setAttribute("data-jlcpcb-element-settings-key", settingsKey);
            // read custom element settings
            if (!elementSettings.hasOwnProperty(settingsKey))
            {
                logDebugMessage("Warning: createPageElement called with unknown settings key '" + settingsKey + "'.");
            }
            else
            {
                let settings = elementSettings[settingsKey];
                if (overrideSettings)
                {
                    settings = Object.assign({}, settings);
                    settings = Object.assign(settings, overrideSettings);
                }
                Object.assign(elementAttribs, settings.attribs);
                elementClasses = Array.from(new Set(elementClasses.concat(settings.classes)));
                if (settings.hasOwnProperty("id"))
                {
                    elementId = settings.id;
                }
            }
        }
        // apply ID, if any
        if (elementId != null)
        {
            newElement.setAttribute("id", elementId);
        }
        // apply attribs, if any
        for (let attribName in elementAttribs)
        {
            newElement.setAttribute(attribName, elementAttribs[attribName]);
        }
        // apply styles, if any
        if (elementClasses.length > 0)
        {
            let elementClassesString = elementClasses.join(' ');
            newElement.setAttribute("class", elementClassesString);
        }
        return newElement;
    };

    var getProductTableBodyElement = function()
    {
        let productTableBodyElement = document.getElementById(pageConsts.productTableBodyId);
        if (!productTableBodyElement)
        {
            logDebugMessage("Warning: getProductTableBodyElement could not find the product table body element.");
        }
        return productTableBodyElement;
    };

    var getProductTableRowElements = function()
    {
        return Array.from(document.querySelectorAll(pageConsts.productTableRowSelector));
    };

    var getMfrPartColumnHeaderElement = function()
    {
        let mfrPartColumnHeaderElement = document.querySelector(pageConsts.mfrPartColumnHeaderSelector);
        if (!mfrPartColumnHeaderElement)
        {
            logDebugMessage("Warning: getMfrPartColumnHeaderElement could not find the column header element.");
        }
        return mfrPartColumnHeaderElement;
    };

    var getFloatingMfrPartColumnHeaderElement = function()
    {
        let mfrPartFloatingColumnHeaderElement = document.querySelector(pageConsts.mfrPartFloatingColumnHeaderSelector);
        if (!mfrPartFloatingColumnHeaderElement)
        {
            logDebugMessage("Warning: getFloatingMfrPartColumnHeaderElement could not find the column header element.");
        }
        return mfrPartFloatingColumnHeaderElement;
    };

    var getMfrPartCellElement = function(row)
    {
        if (!row)
        {
            logDebugMessage("Error: getMfrPartColumnHeaderElement called with null row.");
            return;
        }
        let mfrPartCellElement = row.querySelector(pageConsts.mfrPartCellSelector).parentElement;
        if (!mfrPartCellElement)
        {
            logDebugMessage("Warning: getMfrPartCellElement could not find the cell element.");
        }
        return mfrPartCellElement;
    };

    var getProductPartNumberFromRow = function(row)
    {
        return row.querySelector(pageConsts.productPartNumberSelector).innerText;
    };

    var isProductTablePresent = function()
    {
        return document.body.contains(document.getElementById(pageConsts.productTableContainerId)) &&
            document.body.contains(document.getElementById(pageConsts.productTableBodyId));
    }

    var isColumnHeaderPresent = function(columnName)
    {
        if (!columnSettings.hasOwnProperty(columnName))
        {
            logDebugMessage("Error: isColumnHeaderPresent called with unknown column name '" + columnName + "'.");
            return;
        }
        let settings = columnSettings[columnName];
        let headerCellSettings = elementSettings[settings.headerElementSettingsKey];
        let headerCellId = headerCellSettings.id;
        return document.body.contains(document.getElementById(headerCellId));
    }

    var areAllColumnHeadersPresent = function()
    {
        for (let columnName in columnSettings)
        {
            if (!isColumnHeaderPresent(columnName))
            {
                return false;
            }
        }
        return true;
    };

    var initColumns = function()
    {
        // get column header reference elements (mfr part column header), which are used to position the new column elements
        // there are two (fixed and floating) elements - one for normal use, and the other for when you're scrolling down the page
        let referenceColumnHeaderElement = getMfrPartColumnHeaderElement();
        if (!referenceColumnHeaderElement)
            return false;
        if (!referenceColumnHeaderElement.parentElement)
            return false;
        let referenceFloatingColumnHeaderElement = getFloatingMfrPartColumnHeaderElement();
        if (!referenceFloatingColumnHeaderElement)
            return false;
        if (!referenceFloatingColumnHeaderElement.parentElement)
            return false;
        // add all the columns we want to add
        for (let columnName in columnSettings)
        {
            let columnHeaderSettingsKey = columnSettings[columnName].headerElementSettingsKey;
            let columnHeaderSettings = elementSettings[columnHeaderSettingsKey];

            // add fixed column header
            let fixedColumnHeaderElement = createPageElement("th", columnHeaderSettingsKey);
            fixedColumnHeaderElement.innerHTML = '<div class="fixed-col-th-title">' + columnSettings[columnName].headerText + '</div>';
            referenceColumnHeaderElement.parentNode.insertBefore(fixedColumnHeaderElement, referenceColumnHeaderElement);
            trackPageElement(fixedColumnHeaderElement, "header");

            // add floating column header
            let floatingColumnHeaderElement = createPageElement("th", columnHeaderSettingsKey, { "id": columnHeaderSettings.float_id });
            floatingColumnHeaderElement.innerHTML = '<div class="fixed-col-th-title">' + columnSettings[columnName].headerText + '</div>';
            referenceFloatingColumnHeaderElement.parentNode.insertBefore(floatingColumnHeaderElement, referenceFloatingColumnHeaderElement);
            trackPageElement(floatingColumnHeaderElement, "header");
        }
        return true;
    };

    var resizeColumns = function()
    {
        for (let columnName in columnSettings)
        {
            let headerSettingsKey = columnSettings[columnName].headerElementSettingsKey;
            let cellSettingsKey = columnSettings[columnName].cellElementSettingsKey;
            let headerSettings = elementSettings[headerSettingsKey];
            let cellSettings = elementSettings[cellSettingsKey];
            let headerElementId = headerSettings.id;
            let headerElement = document.getElementById(headerElementId);
            let floatingHeaderElementId = headerSettings.float_id;
            let floatingHeaderElement = document.getElementById(floatingHeaderElementId);
            let cellSelector = "td";
            for (let attribName in cellSettings.attribs)
            {
                cellSelector += "[" + attribName + "=" + cellSettings.attribs[attribName] + "]";
            }
            let cells = Array.from(document.querySelectorAll(cellSelector));
            let maxCellWidth = 0;
            for (let cellIdx in cells)
            {
                maxCellWidth = Math.max(cells[cellIdx].getBoundingClientRect().width, maxCellWidth);
            }
            floatingHeaderElement.style.minWidth = maxCellWidth + 'px';
        }
    }

    var initRowCells = function()
    {
        for (let columnName in columnSettings)
        {
            // add column cells
            let rowElements = getProductTableRowElements();
            for (let rowElementIdx in rowElements)
            {
                let rowElement = rowElements[rowElementIdx];
                let referenceCellElement = getMfrPartCellElement(rowElement);
                if (!referenceCellElement)
                {
                    return false;
                }
                let cellElement = createPageElement("td", columnSettings[columnName].cellElementSettingsKey);
                cellElement.innerHTML = '<div class="template-availability"><div class="avali-instock"><div class="in-stock"><div class="avali-stock-num" style="word-break: normal">...</div>' + /*'<div class="avali-stock-tip" style="word-break: normal">at&nbsp;JLC</div>*/  '</div></div></div>';
                referenceCellElement.parentNode.insertBefore(cellElement, referenceCellElement);
                trackPageElement(referenceCellElement, "cell");
            }
        }
        return true;
    };

    var executeCellHandlers = function()
    {
        let cellElements = Array.from(document.querySelectorAll(pageConsts.jlcpcbCellSelector));
        for (let cellElementIdx in cellElements)
        {
            let cellElement = cellElements[cellElementIdx];
            let settingsKey = cellElement.getAttribute("data-jlcpcb-element-settings-key");
            let settings = elementSettings[settingsKey];
            let handler = settings.handler;
            handler(cellElement);
        }
    };

    /*
    Begin handlers
    */

    var stockCellHandler = function(element)
    {
        let elementRow = element.closest("tr");
        let partId = getProductPartNumberFromRow(elementRow);
        JLCPCB.API.getPartInfo(partId).then(function(partInfo) {
            let stockNumElement = element.querySelector(elementSettings.stockCell.stockNumElementSelector);
            if (partInfo)
            {
                if (partInfo.stockCount > 0)
                {
                    stockNumElement.setAttribute("class", "avali-stock-num");
                }
                else
                {
                    stockNumElement.setAttribute("class", "avali-down");
                }
                stockNumElement.innerText = partInfo.stockCount;
            }
            else
            {
                stockNumElement.setAttribute("class", "avali-down");
                stockNumElement.innerText = "N/A";
            }
            resizeColumns();
        });
    };

    var priceCellHandler = function(element)
    {
        let elementRow = element.closest("tr");
        let partId = getProductPartNumberFromRow(elementRow);
        JLCPCB.API.getPartInfo(partId).then(function(partInfo) {
            let priceElement = element.querySelector(elementSettings.priceCell.priceElementSelector);
            if (partInfo)
            {
                let showLeastNumber = false;

                priceElement.setAttribute("class", "avali-stock-num");
                let priceHTML = '<div class="template-price" style="padding: 0"><div class="product-price" style="height: auto">';
                if (partInfo.hasOwnProperty("prices") && partInfo.prices)
                {
                    for (let priceIdx in partInfo.prices.sort((a, b) => (a.startNumber > b.startNumber) ? 1 : -1))
                    {
                        if (priceIdx > 4)
                            break;
                        priceHTML += '<div class="product-price-panel">';
                        priceHTML += '<div class="product-price-panel-num" style="width: 50px">' + partInfo.prices[priceIdx].startNumber + '+</div>';
                        priceHTML += '<div class="product-price-panel-unit">' + partInfo.prices[priceIdx].productPrice + '</div>';
                        priceHTML += '</div>';
                    }
                }
                else if (partInfo.hasOwnProperty("jlcPrices") && partInfo.jlcPrices)
                {
                    let maxPriceLines = 5;
                    if (partInfo.hasOwnProperty("leastNumber") && partInfo.jlcPrices)
                    {
                        maxPriceLines = 4;
                        showLeastNumber = true;
                    }
                    for (let priceIdx in partInfo.jlcPrices.sort((a, b) => (a.startNumber > b.startNumber) ? 1 : -1))
                    {
                        if (priceIdx > maxPriceLines)
                            break;
                        priceHTML += '<div class="product-price-panel">';
                        priceHTML += '<div class="product-price-panel-num" style="width: 50px">' + partInfo.jlcPrices[priceIdx].startNumber + '+</div>';
                        priceHTML += '<div class="product-price-panel-unit">' + partInfo.jlcPrices[priceIdx].productPrice + '</div>';
                        priceHTML += '</div>';
                    }
                }
                else
                {
                    logDebugMessage("Warning: Invalid price data for part " + partId + ". Part data:");
                    logDebugMessage(partInfo);
                }
                priceHTML += '</div></div>';

                if (showLeastNumber)
                {
                    /*priceHTML += '<div class="product-price-panel">';
                    priceHTML += '<div class="product-price-panel-num" style="width: 50px">(min)</div>';
                    priceHTML += '<div class="product-price-panel-unit">' + partInfo.leastNumber + '</div>';
                    priceHTML += '</div>';*/
                    priceHTML += '<div style="color: gray; padding-top: 4px">min: ' + partInfo.leastNumber + " (" + partInfo.leastNumberPrice + ")</div>";
                    priceHTML += '<div style="color: gray">loss: ' + partInfo.lossNumber + "</div>";
                }

                priceElement.innerHTML = priceHTML;
            }
            else
            {
                priceElement.setAttribute("class", "avali-down");
                priceElement.innerText = "N/A";
            }
            resizeColumns();
        });
    };

    JLCPCB.API.loadCache();

    /*
    Observer - this is used to update everything when the page dynamically changes due to user interaction
    */

    var observer = new MutationObserver(function(mutations)
    {
        // check if the user closed a part (also works for switching which part is open), and if so clean up any elements we added for that part
        let mutationsArray = Array.from(mutations);

        if (!isProductTablePresent())
        {
            return;
        }
        if (!areAllColumnHeadersPresent())
        {
            if (initColumns())
            {
                if (initRowCells())
                {
                    executeCellHandlers();
                    resizeColumns();
                }
            }
        }
        else if (mutationsArray.some((mut) => Array.from(mut.removedNodes).some((rn) => rn.nodeName == "TR")))
        {
            // rows were removed, we're probably switching pages
            logDebugMessage("Switching pages.");
            destroyPageElementsOfType("cell");
            if (initRowCells())
            {
                executeCellHandlers();
                resizeColumns();
            }
        }
    });
    observer.observe(document, {subtree: true, attributes: false, childList: true});
})();
