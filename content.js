const inject = (path) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(path);
    script.onload = function () {
        this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
};

inject('core.js');

if (location.hostname.includes('netflix.com')) {
    inject('adapters/netflix.js');
}
