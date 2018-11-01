const fs = require("fs");
const path = require("path");
const URL = require("url");
const c = require("print-colors");
const _ = require("lodash");
const finalhandler = require("finalhandler");
const serveStatic = require("serve-static");
const resolveHome = require("./resolveHome");
const priv = {};

priv.tryPlugin = (plugin, req, res, target, cb) => {
    if (typeof plugin === "function") {
        plugin(req, res, target).then(t => {
            // Plugin may have sent back a new target
            // if they did use it
            t = t || target;
            cb(t);
        }); // TODO what to do if the plugin Promise fails ??
    } else {
        // Run with the default target
        cb(target);
    }
};

priv.doProxy = (proxy, req, res, target) => {
    if (target) {
        proxy.web(req, res, { target }, e => {
            console.error(e);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end();
        });
    } else {
        res.writeHead(404);
        res.end();
    }
};

module.exports = (conf, proxy) => {
    // for each local file path in the conf, create a serveStatic object for
    // serving that dir
    const serveLocal = _(conf.routes)
        .omitBy(_.isObject)
        .mapValues(dir =>
            serveStatic(path.resolve(conf.configDir, resolveHome(dir)), {
                redirect: true
            })
        )
        .value();
    return (req, res, next) => {
        // figure out which target to proxy to based on the requested resource path
        const sortedRoutes = _(conf.routes)
            .toPairs()
            .sortBy(v => -v[0].length)
            .value();
        const routeIndex = _.findKey(sortedRoutes, v =>
            _.startsWith(req.url, v[0])
        );
        const routeKey = sortedRoutes[routeIndex][0];

        const env = req.headers["x-spandx-env"];
        const route = conf.routes[routeKey];
        let target = route.host && route.host[env];
        // console.log(`env: ${env}`);
        // console.log(`route: ${route}`);
        // console.log(`target: ${target}`);
        let fileExists;
        let needsSlash = false;
        const localFile = !target;

        // determine if the URL path maps to a local directory
        // if it maps to a local directory, and if the file exists, serve it
        // up.  if the URL path maps to an HTTP server, OR if it maps to a file
        // but the file doesn't exist, in either case proxy to a remote server.
        if (localFile) {
            const url = URL.parse(req.url);
            const relativeFilePath = url.pathname.replace(
                new RegExp(`^${routeKey}/?`),
                "/"
            ); // remove route path (will be replaced with disk path)
            const absoluteFilePath = path.resolve(
                conf.configDir,
                resolveHome(route),
                relativeFilePath.replace(/^\//, "")
            );
            fileExists = fs.existsSync(absoluteFilePath);

            if (fileExists) {
                if (conf.verbose) {
                    console.log(
                        `GET ${c.fg.l.green}${req.url}${c.end} from ${
                            c.fg.l.cyan
                        }${absoluteFilePath}${c.end} ${env}`
                    );
                }

                req.url = relativeFilePath; // update the request's url to be relative to the on-disk dir
                serveLocal[routeKey](req, res, finalhandler(req, res));
                return; // stop here, don't continue to HTTP proxy section
            }
        }

        if (localFile && (!fileExists || needsSlash)) {
            target = conf.routes["/"].host
                ? conf.routes["/"].host[env]
                : undefined;
        }

        if (conf.verbose) {
            console.log(
                `GET ${c.fg.l.green}${req.url}${c.end} from ${
                    c.fg.l.blue
                }${target}${c.end}${c.fg.l.green}${req.url}${c.end}`
            );
        }

        priv.tryPlugin(conf.routerPlugin, req, res, target, t => {
            priv.doProxy(proxy, req, res, t);
        });
    };
};

if (process.env.NODE_ENV === "test") {
    // only leak in test
    module.exports.priv = priv;
}
