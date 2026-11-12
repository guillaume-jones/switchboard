/// <reference path="../switchboard.d.ts" />
// Cards are typechecked against switchboard.d.ts but run against ./switchboard; this fails to compile when they drift.
import type * as Declared from 'switchboard'
import type * as Implemented from './switchboard'

;({}) as typeof Implemented satisfies typeof Declared
