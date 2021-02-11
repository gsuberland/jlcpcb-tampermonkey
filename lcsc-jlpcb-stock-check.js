// ==UserScript==
// @name         JLCPCB stock check for LCSC
// @namespace    https://poly.nomial.co.uk/
// @version      0.4
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
    "currencyElementSelector": "#header span.options-usd",
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
        for (let id in this.cache)
        {
            let cacheAge = Date.now() - this.cache[id].time;
            if (cacheAge > this.cachePeriod)
            {
                GM_log("[JLCPCB Stock Tampermonkey] Evicting part " + this.cache[id].id + " from persistent cache as it is " + (cacheAge / (1000 * 60 * 60 * 24)).toFixed(2) + " days old.");
                delete this.cache[id];
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

class LCSC
{
    constructor()
    {
        this.exchangeRate = GM_getValue("LCSC.Cache.ExchangeRate", null);
        this.exchangeCurrency = GM_getValue("LCSC.Cache.ExchangeCurrency", null);
        this.exchangeCurrencySymbol = GM_getValue("LCSC.Cache.ExchangeCurrencySymbol", "");
        this.cacheAge = GM_getValue("LCSC.Cache.Age", null);

        this.cachePeriod = 1000 * 60 * 60 * 24 * 1; /* 1 day */

        if (this.cacheAge)
        {
            if (Date.now() - this.cacheAge > this.cachePeriod)
            {
                GM_log("[JLCPCB Stock Tampermonkey] Evicting exchange rate from cache.");
                this.clearCache();
            }
        }
        else
        {
            GM_log("[JLCPCB Stock Tampermonkey] Got exchange rate of " + this.exchangeRate + " from cache.");
        }
        this.pendingPromise = null;
    }

    setCurrency(currency)
    {
        currency = currency.toUpperCase();
        if (this.exchangeCurrency != currency)
        {
            // new currency selected, purge cache
            GM_log("[JLCPCB Stock Tampermonkey] New currency selected. Clearing cache.");
            this.clearCache();
        }
        this.exchangeCurrency = currency;
    }

    updateCache()
    {
        GM_setValue("LCSC.Cache.ExchangeRate", this.exchangeRate);
        GM_setValue("LCSC.Cache.ExchangeCurrency", this.exchangeCurrency);
        GM_setValue("LCSC.Cache.ExchangeCurrencySymbol", this.exchangeCurrencySymbol);
        GM_setValue("LCSC.Cache.Age", Date.now());
    }

    clearCache()
    {
        this.exchangeRate = null;
        this.exchangeCurrency = null;
        this.exchangeCurrencySymbol = "$";
        this.cacheAge = null;
        GM_setValue("LCSC.Cache.ExchangeRate", null);
        GM_setValue("LCSC.Cache.ExchangeCurrency", null);
        GM_setValue("LCSC.Cache.ExchangeCurrencySymbol", "");
        GM_setValue("LCSC.Cache.Age", null);
    }

    async getExchangeRate()
    {
        let exchangeRate = await this.getExchangeRateInternal();
        return exchangeRate;
    }

    async getExchangeCurrencySymbol()
    {
        // we need an exchange rate value to get the symbol. we don't care about the results.
        // making additional calls is fine because we're caching stuff.
        await this.getExchangeRateInternal();
        return this.exchangeCurrencySymbol;
    }

    async getExchangeRateInternal()
    {
        if (this.exchangeRate)
        {
            return new Promise((resolve,reject) => resolve(this.exchangeRate));
        }
        if (this.pendingPromise)
        {
            logDebugMessage("Pending exchange rate fetch...");
            return this.pendingPromise;
        }

        let xhrOpt = {
            "method": "POST",
            "url": "https://lcsc.com/api/products/search?q=test",
            "responseType": "json",
            "headers": {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "x-csrf-token": $.ajaxSettings.headers["X-CSRF-TOKEN"],
            },
            "overrideMimeType": "application/x-www-form-urlencoded; charset=UTF-8",
            "data": "page=1&limit=1&in_stock=true&" + encodeURI("order[0][field]") + "=price&" + encodeURI("order[0][sort]") + "=desc",
        };

        var promise = new Promise((resolve, reject) => {
            xhrOpt.onload = resolve;
            xhrOpt.onerror = xhrOpt.ontimeout = reject;
            GM_xmlhttpRequest(xhrOpt);
        }).then(
            /* success */
            function(results)
            {
                if (results.response && results.response.code == 200 && results.response.result && results.response.result.data && results.response.result.data.length > 0)
                {
                    let partData = results.response.result.data[0];
                    if (partData.price && partData.price.length > 0)
                    {
                        logDebugMessage("Got part pricing data for currency conversion.");
                        logDebugMessage(partData);
                        let sortedPrices = partData.price.sort((a, b) => (a[0] > b[0]) ? 1 : -1);
                        let usdPrice = sortedPrices[0][1];
                        let localPrice = sortedPrices[0][2];
                        let symbol = sortedPrices[0][3];
                        let conversionRate = localPrice / usdPrice;
                        logDebugMessage("USD price: " + usdPrice + ", local price: " + localPrice + ", rate: " + conversionRate + ", symbol: " + symbol);
                        LCSC.API.exchangeRate = conversionRate;
                        LCSC.API.exchangeCurrencySymbol = symbol;
                        LCSC.API.pendingPromise = null;
                        LCSC.API.updateCache();
                        return conversionRate;
                    }
                    else
                    {
                        logDebugMessage("Failed to read pricing from product " + partData.number + " for automatic currency conversion. Response:");
                        logDebugMessage(results.response);
                    }
                }
                else
                {
                    logDebugMessage("Failed to read product for automatic currency conversion. HTTP request did not return correct data. Response:");
                    logDebugMessage(results.response);
                }
            },
            /* error */
            function (results)
            {
                logDebugMessage("Failed to read product data for automatic currency conversion.");
            }
        );
        this.pendingPromise = promise;
        return promise;
    }

    static API = new LCSC();
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

var getCurrencyIdentifier = function()
{
    return document.querySelector(pageConsts.currencyElementSelector).innerText.trim();
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
            cellElement.innerHTML = '<div class="template-availability"><div class="avali-instock"><div class="in-stock"><div class="avali-stock-num" style="word-break: normal"><span data-jlcpcb-element-type="stock">...</span><span data-jlcpcb-element-type="library"></span><br /><a style="display: none" href="#"></a><span style="color: black; white-space: nowrap;" data-jlcpcb-element-type="process"></span></div>' + /*'<div class="avali-stock-tip" style="word-break: normal">at&nbsp;JLC</div>*/  '</div></div></div>';
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

var validatePartInfo = function(partInfo)
{
    // some parts return pricing & stock data but aren't actually on the site
    // these can be identified by some of their fields being null
    if (!partInfo.componentName)
        return false;
    return true;
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
        stockNumElement.setAttribute("data-for-part", partId);
        if (partInfo && validatePartInfo(partInfo))
        {
            if (partInfo.stockCount > 0)
            {
                stockNumElement.setAttribute("class", "avali-stock-num");
            }
            else
            {
                stockNumElement.setAttribute("class", "avali-down");
            }
            stockNumElement.querySelector("span[data-jlcpcb-element-type=stock]").innerText = partInfo.stockCount;
            let extendedPart = (partInfo.componentLibraryType ?? "") == "expand";
            let thPart = (partInfo.assemblyMode ?? "") == "THT";
            stockNumElement.querySelector("span[data-jlcpcb-element-type=library]").innerHTML = extendedPart ? "&nbsp;(E)" : "&nbsp;(B)";
            stockNumElement.querySelector("span[data-jlcpcb-element-type=library]").title = extendedPart ? "Extended library" : "Basic library";
            stockNumElement.querySelector("span[data-jlcpcb-element-type=library]").style.color = extendedPart ? "red" : "blue";
            stockNumElement.querySelector("span[data-jlcpcb-element-type=process]").innerText = thPart ? "TH" : "SMT";
            stockNumElement.querySelector("span[data-jlcpcb-element-type=process]").title = thPart ? "Through Hole (hand soldered)" : "Surface Mount";
            stockNumElement.querySelector("a").style.display = "inherit";
            stockNumElement.querySelector("a").innerText = "JLCPCB";
            stockNumElement.querySelector("a").href = "https://jlcpcb.com/parts/componentSearch?searchTxt=" + encodeURIComponent(partInfo.componentCode);
        }
        else
        {
            stockNumElement.querySelector("a").style.display = "none";
            stockNumElement.querySelector("span[data-jlcpcb-element-type=process]").innerText = "";
            stockNumElement.setAttribute("class", "avali-down");
            stockNumElement.querySelector("span[data-jlcpcb-element-type=stock]").innerText = "N/A";
        }
        resizeColumns();
    });
};

var convertPriceToLocal = async function(price)
{
    let exchangeRate = await LCSC.API.getExchangeRate();
    if (!exchangeRate)
    {
        return price;
    }

    let parts = price.toString().split(".");
    if (parts.length > 2)
    {
        logDebugMessage("Error: Part price " + price + " has more than two parts; cannot convert to local.");
        return price;
    }

    let precision = 0;
    if (parts.length == 2)
    {
        precision = parts[1].length;
    }
    if (precision < 3)
    {
        precision = 3;
    }
    if (precision > 5)
    {
        precision = 5;
    }
    let localPrice = parseFloat(price.toString()) * exchangeRate;
    return Math.ceil10(localPrice, -precision);
}

var priceCellHandler = function(element)
{
    let elementRow = element.closest("tr");
    let partId = getProductPartNumberFromRow(elementRow);
    JLCPCB.API.getPartInfo(partId).then(async function(partInfo) {
        let priceElement = element.querySelector(elementSettings.priceCell.priceElementSelector);
        if (partInfo && validatePartInfo(partInfo))
        {
            let showLeastNumber = false;

            priceElement.setAttribute("class", "avali-stock-num");
            let priceHTML = '<div class="template-price" style="padding: 0"><div class="product-price" style="height: auto">';
            let maxPriceLines = 5;
            if (partInfo.hasOwnProperty("leastNumber") && partInfo.leastNumber)
            {
                maxPriceLines = 4;
                showLeastNumber = true;
            }
            if (partInfo.hasOwnProperty("prices") && partInfo.prices)
            {
                for (let priceIdx in partInfo.prices.sort((a, b) => (a.startNumber > b.startNumber) ? 1 : -1))
                {
                    if (priceIdx > maxPriceLines)
                        break;
                    priceHTML += '<div class="product-price-panel">';
                    priceHTML += '<div class="product-price-panel-num" style="width: 50px">' + partInfo.prices[priceIdx].startNumber + '+</div>';
                    priceHTML += '<div class="product-price-panel-unit">' + await LCSC.API.getExchangeCurrencySymbol() + await convertPriceToLocal(partInfo.prices[priceIdx].productPrice) + '</div>';
                    priceHTML += '</div>';
                }
            }
            else if (partInfo.hasOwnProperty("jlcPrices") && partInfo.jlcPrices)
            {
                for (let priceIdx in partInfo.jlcPrices.sort((a, b) => (a.startNumber > b.startNumber) ? 1 : -1))
                {
                    if (priceIdx > maxPriceLines)
                        break;
                    priceHTML += '<div class="product-price-panel">';
                    priceHTML += '<div class="product-price-panel-num" style="width: 50px">' + partInfo.jlcPrices[priceIdx].startNumber + '+</div>';
                    priceHTML += '<div class="product-price-panel-unit">' + await LCSC.API.getExchangeCurrencySymbol() + await convertPriceToLocal(partInfo.jlcPrices[priceIdx].productPrice) + '</div>';
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
                priceHTML += '<div style="color: gray; padding-top: 4px">min: ' + partInfo.leastNumber + " (" + await LCSC.API.getExchangeCurrencySymbol() + await convertPriceToLocal(partInfo.leastNumberPrice) + ")</div>";
                if (partInfo.hasOwnProperty("lossNumber") && partInfo.lossNumber)
                {
                    priceHTML += '<div style="color: gray">loss: ' + partInfo.lossNumber + "</div>";
                }
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
var currencyIdentifier = getCurrencyIdentifier();
if (currencyIdentifier)
{
    LCSC.API.setCurrency(currencyIdentifier);
}

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

(function(){

    /**
     * Decimal adjustment of a number.
     *
     * @param   {String}    type    The type of adjustment.
     * @param   {Number}    value   The number.
     * @param   {Integer}   exp     The exponent (the 10 logarithm of the adjustment base).
     * @returns {Number}            The adjusted value.
     */
    function decimalAdjust(type, value, exp) {
        // If the exp is undefined or zero...
        if (typeof exp === 'undefined' || +exp === 0) {
            return Math[type](value);
        }
        value = +value;
        exp = +exp;
        // If the value is not a number or the exp is not an integer...
        if (isNaN(value) || !(typeof exp === 'number' && exp % 1 === 0)) {
            return NaN;
        }
        // Shift
        value = value.toString().split('e');
        value = Math[type](+(value[0] + 'e' + (value[1] ? (+value[1] - exp) : -exp)));
        // Shift back
        value = value.toString().split('e');
        return +(value[0] + 'e' + (value[1] ? (+value[1] + exp) : exp));
    }

    // Decimal round
    if (!Math.round10) {
        Math.round10 = function(value, exp) {
            return decimalAdjust('round', value, exp);
        };
    }
    // Decimal floor
    if (!Math.floor10) {
        Math.floor10 = function(value, exp) {
            return decimalAdjust('floor', value, exp);
        };
    }
    // Decimal ceil
    if (!Math.ceil10) {
        Math.ceil10 = function(value, exp) {
            return decimalAdjust('ceil', value, exp);
        };
    }
})();
