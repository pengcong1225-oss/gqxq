import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequestGeneration} from './src/request-generation.js'
test('query changes invalidate older detail and retry generations',()=>{const g=createRequestGeneration();const detail=g.next();assert.equal(g.isCurrent(detail),true);g.next();assert.equal(g.isCurrent(detail),false);const retry=g.current();assert.equal(g.isCurrent(retry),true);g.next();assert.equal(g.isCurrent(retry),false)})
