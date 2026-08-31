import { normalizePath } from './utils.js';

export class SelectionState {
  constructor(include = [], exclude = []) {
    this.include = new Set(include.map(normalizePath));
    this.exclude = new Set(exclude.map(normalizePath));
  }

  clear() {
    this.include.clear();
    this.exclude.clear();
  }

  get size() {
    return this.getTopLevelIncludes().length;
  }

  get hasSelection() {
    return this.include.size > 0;
  }

  isPathSelected(path) {
    if (!path) return false;
    const norm = normalizePath(path);
    let longestMatchLen = -1;
    let matchType = null;

    for (const inc of this.include) {
      if (norm === inc || inc === '/' || norm.startsWith(inc + '/')) {
        const len = inc === '/' ? 1 : inc.length;
        if (len > longestMatchLen) {
          longestMatchLen = len;
          matchType = 'include';
        }
      }
    }

    for (const exc of this.exclude) {
      if (norm === exc || exc === '/' || norm.startsWith(exc + '/')) {
        const len = exc === '/' ? 1 : exc.length;
        if (len > longestMatchLen) {
          longestMatchLen = len;
          matchType = 'exclude';
        }
      }
    }

    return matchType === 'include';
  }

  isPathIndeterminate(path) {
    if (!path) return false;
    const norm = normalizePath(path);
    const selected = this.isPathSelected(norm);

    if (selected) {
      for (const exc of this.exclude) {
        if (exc !== norm && (norm === '/' || exc.startsWith(norm + '/'))) {
          if (!this.isPathSelected(exc)) {
            return true;
          }
        }
      }
      return false;
    } else {
      for (const inc of this.include) {
        if (inc !== norm && (norm === '/' || inc.startsWith(norm + '/'))) {
          if (this.isPathSelected(inc)) {
            return true;
          }
        }
      }
      return false;
    }
  }

  _longestAncestor(normPath) {
    let longestMatch = null;
    let longestMatchLen = -1;
    let matchType = null;

    for (const inc of this.include) {
      if (inc !== normPath && (inc === '/' || normPath.startsWith(inc + '/'))) {
        const len = inc === '/' ? 1 : inc.length;
        if (len > longestMatchLen) {
          longestMatchLen = len;
          longestMatch = inc;
          matchType = 'include';
        }
      }
    }

    for (const exc of this.exclude) {
      if (exc !== normPath && (exc === '/' || normPath.startsWith(exc + '/'))) {
        const len = exc === '/' ? 1 : exc.length;
        if (len > longestMatchLen) {
          longestMatchLen = len;
          longestMatch = exc;
          matchType = 'exclude';
        }
      }
    }

    return { match: longestMatch, type: matchType };
  }

  select(path) {
    const norm = normalizePath(path);
    this.exclude.delete(norm);

    for (const exc of Array.from(this.exclude)) {
      if (norm === '/' ? exc !== '/' : exc.startsWith(norm + '/')) {
        this.exclude.delete(exc);
      }
    }
    for (const inc of Array.from(this.include)) {
      if (norm === '/' ? inc !== '/' : inc.startsWith(norm + '/')) {
        this.include.delete(inc);
      }
    }

    const ancestor = this._longestAncestor(norm);
    if (ancestor.type !== 'include') {
      this.include.add(norm);
    }
  }

  unselect(path) {
    const norm = normalizePath(path);
    this.include.delete(norm);

    for (const inc of Array.from(this.include)) {
      if (norm === '/' ? inc !== '/' : inc.startsWith(norm + '/')) {
        this.include.delete(inc);
      }
    }
    for (const exc of Array.from(this.exclude)) {
      if (norm === '/' ? exc !== '/' : exc.startsWith(norm + '/')) {
        this.exclude.delete(exc);
      }
    }

    const ancestor = this._longestAncestor(norm);
    if (ancestor.type === 'include') {
      this.exclude.add(norm);
    }
  }

  migratePath(oldPath, newPath) {
    const normOld = normalizePath(oldPath);
    const normNew = normalizePath(newPath);
    if (normOld === normNew) return;

    const prefixOld = normOld === '/' ? '/' : normOld + '/';

    const newInclude = new Set();
    for (const inc of this.include) {
      if (inc === normOld) {
        newInclude.add(normNew);
      } else if (inc.startsWith(prefixOld)) {
        newInclude.add(normNew + inc.slice(normOld.length));
      } else {
        newInclude.add(inc);
      }
    }
    this.include = newInclude;

    const newExclude = new Set();
    for (const exc of this.exclude) {
      if (exc === normOld) {
        newExclude.add(normNew);
      } else if (exc.startsWith(prefixOld)) {
        newExclude.add(normNew + exc.slice(normOld.length));
      } else {
        newExclude.add(exc);
      }
    }
    this.exclude = newExclude;
  }

  deletePath(path) {
    const norm = normalizePath(path);
    const prefix = norm === '/' ? '/' : norm + '/';

    for (const inc of Array.from(this.include)) {
      if (inc === norm || inc.startsWith(prefix)) {
        this.include.delete(inc);
      }
    }
    for (const exc of Array.from(this.exclude)) {
      if (exc === norm || exc.startsWith(prefix)) {
        this.exclude.delete(exc);
      }
    }
  }

  getTopLevelIncludes() {
    const roots = [];
    for (const inc of this.include) {
      const ancestor = this._longestAncestor(inc);
      if (ancestor.type !== 'include') {
        roots.push(inc);
      }
    }
    return roots.sort();
  }

  toTransferSources() {
    const topIncludes = this.getTopLevelIncludes();
    const result = [];

    for (const root of topIncludes) {
      const prefix = root === '/' ? '/' : root + '/';
      const relativeExcludes = [];
      for (const exc of this.exclude) {
        if (exc.startsWith(prefix)) {
          let closestInc = null;
          let closestLen = -1;
          for (const inc of this.include) {
            if (exc.startsWith(inc === '/' ? '/' : inc + '/')) {
              const len = inc === '/' ? 1 : inc.length;
              if (len > closestLen) {
                closestLen = len;
                closestInc = inc;
              }
            }
          }
          if (closestInc === root) {
            const rel = root === '/' ? exc.slice(1) : exc.slice(root.length + 1);
            if (rel) {
              relativeExcludes.push(rel);
            }
          }
        }
      }

      if (relativeExcludes.length === 0) {
        result.push(root);
      } else {
        result.push({
          path: root,
          excludes: relativeExcludes.sort(),
        });
      }
    }

    return result;
  }
}

