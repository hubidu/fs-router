const path = require('path')
const fs = require('fs')
const qs = require('querystring')
const extract = require('babel-extract-comments')

const extractCommentFromFile = (fileName) => {
  const content = fs.readFileSync(fileName, 'utf8')
  return extract(content)
}

const paramPattern = /[:%]([^/]+)/
// takes routes and decorates them with a 'match' method that will return { params, query } if a path matches
function addMatch (route) {
  let routePath = route.path
  let paramNames = []
  let matched

  // Extract http method from path
  const HTTP_METHOD_REGEX = /\.get|\.post|\.put|\.delete|\.patch/;
  const match = routePath.match(HTTP_METHOD_REGEX)
  if (match) {
    route.methods = [match[0].replace('.', '').toUpperCase()]
    routePath = routePath.replace(HTTP_METHOD_REGEX, '')
    route.path = routePath
  } else {
    route.methods = ['ANY']
  }

  // find any paths prefixed with a `:` or `%` (Windows), and treat them as capture groups
  while ((matched = routePath.match(paramPattern)) !== null) {
    routePath = routePath.replace(paramPattern, '([^?/]+)')
    paramNames.push(matched[1])
  }
  // if a route ends with `index`, allow matching that route without matching the `index` part
  if (path.basename(routePath) === 'index') {
    route.isIndex = true
    routePath = routePath.replace(/\/index$/, '/?([:%]?index)?')
  }
  // create a regex with our path
  let pattern = new RegExp(`^${routePath}(\\?(.*)|$)`, 'i')
  route.pattern = pattern
  route.match = url => {
    let m = url.match(pattern)
    if (m) {
      let params = paramNames.reduce((o, p, idx) => {
        o[p] = m[idx + 1]
        return o
      }, {})
      let query = qs.parse(m[m.length - 1])
      return { params, query }
    }
  }
  // add supported methods to the route
  // route.methods = typeof route === 'function' ? 
  //   ['ANY'] : 
  //   Object.keys(route).filter(m => ['GET', 'POST', 'PUT', 'DELETE'].indexOf(m.toUpperCase()) > -1);

  return route
}

// recursively searches for all js files inside a directory tree, and returns their full paths
function findRoutes (dir) {
  let files = fs.readdirSync(dir)
  let resolve = f => path.join(dir, f)
  let routes = files.filter(f => path.extname(f) === '.js').map(resolve)
  let dirs = files.filter(f => fs.statSync(path.join(dir, f)).isDirectory()).map(resolve)
  return routes.concat(...dirs.map(findRoutes))
}

const val = v => (typeof v === 'undefined' ? 0 : v)
module.exports = function router (routesDir, config) {
  const routes = findRoutes(routesDir)
    // if filter function is set, filter routes
    .filter(config && config.filter || function () { return true })
    // require route files, then add a 'path' property to them
    // the path is in the form of '/path/file', relative to routesDir
    .map(routeFile => {
      let route = require(routeFile)
      route.comment = extractCommentFromFile(routeFile)

      let extPattern = new RegExp(path.extname(routeFile) + '$')
      if (!route.path) {
        route.path = '/' + path.relative(routesDir, routeFile).replace(extPattern, '')
        //Fix issue with windows paths
        // Replace ALL occurrences of \\
        route.path = route.path.replace(/\\/g, '/')
      }
      return route
    })
    // add a match function
    .map(addMatch)
    // sort named files ahead of subfolder index files
    .map(route => {
      if (!route.priority && route.isIndex) route.priority = -1
      return route
    })
    // param routes should not override specific routes (/users/login should take precedence over /users/:id)
    // and also over /users/index
    .sort((a, b) => {
      const aa = a.path.replace(/[:%]/g, '~');
      const bb = b.path.replace(/[:%]/g, '~')
      if (aa < bb) {
        return -1;
      } else if (aa > bb) {
        return 1;
      } else {
        return 0;
      }
    })
    // if a route exposes a `priority` property, sort the route on it.
    .sort((a, b) => val(a.priority) < val(b.priority) ? 1 : -1)

  // generated match method - call with a req object to get a route.
  const matchFn = function match (req) {
    // let routeFn = r => r[req.method] || (typeof r === 'function' && r)
    // const routeFn = r => (r.methods.indexOf(req.method) >= 0 || r.methods.indexOf('ANY') >= 0) && typeof r === 'function'
    const routeFn = r => {
      if (r.methods.indexOf(req.method) >= 0 || r.methods.indexOf('ANY') >= 0) {
        return r
      }
      return undefined
    }

    let found = routes.find(r => {
      let matched = r.match(req.url)
      let hasFn = routeFn(r)
      if (matched && hasFn) {
        Object.assign(req, matched) // ???
        return true
      }
    })
    if (found) return routeFn(found)
  }
  matchFn._routes = routes;
  return matchFn;
}
