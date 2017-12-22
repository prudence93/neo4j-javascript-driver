/**
 * Copyright (c) 2002-2017 "Neo Technology,","
 * Network Engine for Objects in Lund AB [http://neotechnology.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {promiseOrTimeout} from './util';
import PoolConfig from './pool-config';

class Pool {
  /**
   * @param {function} create  an allocation function that creates a new resource. It's given
   *                a single argument, a function that will return the resource to
   *                the pool if invoked, which is meant to be called on .dispose
   *                or .close or whatever mechanism the resource uses to finalize.
   * @param {function} destroy called with the resource when it is evicted from this pool
   * @param {function} validate called at various times (like when an instance is acquired and
   *                 when it is returned). If this returns false, the resource will
   *                 be evicted
   * @param {PoolConfig} config configuration for the new driver.
   */
  constructor(create, destroy = (() => true), validate = (() => true), config = PoolConfig.defaultConfig()) {
    this._create = create;
    this._destroy = destroy;
    this._validate = validate;
    this._maxSize = config.maxSize;
    this._acquisitionTimeout = config.acquisitionTimeout;
    this._pools = {};
    this._acquireRequests = {};
    this._activeResourceCounts = {};
    this._release = this._release.bind(this);
  }

  /**
   * Acquire and idle resource fom the pool or create a new one.
   * @param {string} key the resource key.
   * @return {object} resource that is ready to use.
   */
  acquire(key) {
    const resource = this._acquire(key);

    if (resource) {
      resourceAcquired(key, this._activeResourceCounts);

      return Promise.resolve(resource);
    }

    // We're out of resources and will try to acquire later on when an existing resource is released.
    const allRequests = this._acquireRequests;
    const requests = allRequests[key];
    if (!requests) {
      allRequests[key] = [];
    }

    let request;

    return promiseOrTimeout(
        this._acquisitionTimeout,
        new Promise(
          (resolve, reject) => {
            request = new PendingRequest(resolve);

            allRequests[key].push(request);
          }
        ), () => {
          allRequests[key] = allRequests[key].filter(item => item !== request);
        }
    );
  }

  /**
   * Destroy all idle resources for the given key.
   * @param {string} key the resource key to purge.
   */
  purge(key) {
    const pool = this._pools[key] || [];
    while (pool.length) {
      const resource = pool.pop();
      this._destroy(resource)
    }
    delete this._pools[key]
  }

  /**
   * Destroy all idle resources in this pool.
   */
  purgeAll() {
    Object.keys(this._pools).forEach(key => this.purge(key));
  }

  /**
   * Check if this pool contains resources for the given key.
   * @param {string} key the resource key to check.
   * @return {boolean} <code>true</code> when pool contains entries for the given key, <code>false</code> otherwise.
   */
  has(key) {
    return (key in this._pools);
  }

  /**
   * Get count of active (checked out of the pool) resources for the given key.
   * @param {string} key the resource key to check.
   * @return {number} count of resources acquired by clients.
   */
  activeResourceCount(key) {
    return this._activeResourceCounts[key] || 0;
  }

  _acquire(key) {
    let pool = this._pools[key];
    if (!pool) {
      pool = [];
      this._pools[key] = pool;
    }
    while (pool.length) {
      const resource = pool.pop();

      if (this._validate(resource)) {
        // idle resource is valid and can be acquired
        return resource;
      } else {
        this._destroy(resource);
      }
    }

    if (this._maxSize && this.activeResourceCount(key) >= this._maxSize) {
      return null;
    }

    // there exist no idle valid resources, create a new one for acquisition
    return this._create(key, this._release);
  }

  _release(key, resource) {
    const pool = this._pools[key];

    if (pool) {
      // there exist idle connections for the given key
      if (!this._validate(resource)) {
        this._destroy(resource);
      } else {
        pool.push(resource);
      }
    } else {
      // key has been purged, don't put it back, just destroy the resource
      this._destroy(resource);
    }

    // check if there are any pending requests
    const requests = this._acquireRequests[key];
    if (requests) {
      const pending = requests.shift();

      if (pending) {
        const resource = this._acquire(key);
        if (resource) {
          pending.resolve(resource);

          return;
        }
      } else {
        delete this._acquireRequests[key];
      }
    }

    resourceReleased(key, this._activeResourceCounts);
  }
}

/**
 * Increment active (checked out of the pool) resource counter.
 * @param {string} key the resource group identifier (server address for connections).
 * @param {Object.<string, number>} activeResourceCounts the object holding active counts per key.
 */
function resourceAcquired(key, activeResourceCounts) {
  const currentCount = activeResourceCounts[key] || 0;
  activeResourceCounts[key] = currentCount + 1;
}

/**
 * Decrement active (checked out of the pool) resource counter.
 * @param {string} key the resource group identifier (server address for connections).
 * @param {Object.<string, number>} activeResourceCounts the object holding active counts per key.
 */
function resourceReleased(key, activeResourceCounts) {
  const currentCount = activeResourceCounts[key] || 0;
  const nextCount = currentCount - 1;

  if (nextCount > 0) {
    activeResourceCounts[key] = nextCount;
  } else {
    delete activeResourceCounts[key];
  }
}

class PendingRequest {

  constructor(resolve) {
    this._resolve = resolve;
  }

  resolve(resource) {
    this._resolve(resource);
  }

}

export default Pool
