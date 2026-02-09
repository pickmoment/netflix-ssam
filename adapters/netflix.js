(() => {
  const waitForCore = () => new Promise((resolve) => {
    const check = () => {
      if (window.SSAMCore) return resolve(window.SSAMCore);
      setTimeout(check, 50);
    };
    check();
  });

  let activeVideoId = null;
  let initInterval = null;
  let sessionInterval = null;
  let videoPlayer = null;

  function checkUrlState(core) {
    const match = window.location.pathname.match(/\/watch\/(\d+)/);
    if (match) {
      const newId = match[1];
      if (newId !== activeVideoId) {
        activeVideoId = newId;
        core.handleVideoChange(newId);
        startExtensionInit(core);
      }
    } else {
      if (activeVideoId !== null) {
        activeVideoId = null;
        core.handleVideoChange(null);
      }
    }
  }

  function startExtensionInit(core) {
    if (initInterval) return;
    initInterval = setInterval(() => {
      if (window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer) {
        clearInterval(initInterval);
        initInterval = null;
        videoPlayer = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
        pollForSession(core);
      }
    }, 500);
  }

  function pollForSession(core) {
    if (sessionInterval) return;
    sessionInterval = setInterval(() => {
      if (!videoPlayer) return;
      try {
        const sessions = videoPlayer.getAllPlayerSessionIds();
        if (sessions && sessions.length > 0) {
          const activeSession = sessions.find(s => s && s !== 'undefined');
          if (activeSession) {
            clearInterval(sessionInterval);
            sessionInterval = null;
            const player = videoPlayer.getVideoPlayerBySessionId(activeSession);
            core.setPlayer(player);
          }
        }
      } catch (e) {
        console.error('Session poll error', e);
      }
    }, 1000);
  }

  function installInterceptors(core) {
    // XHR interceptor
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._url = url;
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (window.location.pathname.includes('/watch/')) {
        this.addEventListener('load', function () {
          const url = this._url;
          if (url && (url.includes('/range/') || url.includes('?o=')) && (url.includes('.xml') || url.includes('nflxvideo.net'))) {
            try {
              let text = '';
              if (this.responseType === 'arraybuffer') {
                const decoder = new TextDecoder('utf-8');
                text = decoder.decode(this.response);
              } else if (this.responseType === 'text' || this.responseType === '') {
                text = this.responseText;
              }

              if (text) {
                core.processSubtitleText(url, text);
              }
            } catch (e) { }
          }
        });
      }
      return originalSend.apply(this, arguments);
    };

    // Fetch interceptor
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const [resource, config] = args;
      const response = await originalFetch(resource, config);

      if (window.location.pathname.includes('/watch/')) {
        try {
          const url = (typeof resource === 'string') ? resource : resource.url;
          if (url && (url.includes('.xml') || url.includes('nflxvideo.net') || url.includes('/?o='))) {
            const clone = response.clone();
            clone.text().then(text => {
              core.processSubtitleText(url, text);
            }).catch(e => { });
          }
        } catch (e) { }
      }

      return response;
    };
  }

  waitForCore().then((core) => {
    installInterceptors(core);
    setInterval(() => checkUrlState(core), 500);
    checkUrlState(core);
  });
})();
