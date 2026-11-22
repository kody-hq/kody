import { Schema } from 'effect'

/** The publish-offload flag is off for the publisher (MCP caller error). */
export class PublishOffloadDisabled extends Schema.TaggedError<PublishOffloadDisabled>()(
	'PublishOffloadDisabled',
	{ message: Schema.String },
) {}

/** The commit-time gate refused the build (MCP caller error). */
export class PublishBuildRejected extends Schema.TaggedError<PublishBuildRejected>()(
	'PublishBuildRejected',
	{ reason: Schema.String },
) {}

/** The bearer ticket does not open this build, or it expired (401). */
export class PublishBuildTicketInvalid extends Schema.TaggedError<PublishBuildTicketInvalid>()(
	'PublishBuildTicketInvalid',
	{},
) {}

/** A sealed document read from R2 does not have the document shape. */
export class PublishBuildDocumentUnreadable extends Schema.TaggedError<PublishBuildDocumentUnreadable>()(
	'PublishBuildDocumentUnreadable',
	{ buildId: Schema.String, message: Schema.String },
) {}

/** Each context-build failure carries the exact message its edge reports. */
const contextFailure = { message: Schema.String }

/** 401 `insufficient_scope`: no signed-in person to build for. */
export class PublishContextNeedsPerson extends Schema.TaggedError<PublishContextNeedsPerson>()(
	'PublishContextNeedsPerson',
	contextFailure,
) {}

/** 403 `insufficient_scope`: a context run tried to start a context build. */
export class PublishContextFromContextRun extends Schema.TaggedError<PublishContextFromContextRun>()(
	'PublishContextFromContextRun',
	contextFailure,
) {}

/** 409 `execution_context_unavailable`: nothing took the build. */
export class PublishContextUnavailable extends Schema.TaggedError<PublishContextUnavailable>()(
	'PublishContextUnavailable',
	contextFailure,
) {}

/** 504 `execution_context_unavailable`: the run outlived its time limit. */
export class PublishContextTimedOut extends Schema.TaggedError<PublishContextTimedOut>()(
	'PublishContextTimedOut',
	contextFailure,
) {}

/** 403 `feature_disabled`: a named context without both flags on. */
export class PublishContextFlagsOff extends Schema.TaggedError<PublishContextFlagsOff>()(
	'PublishContextFlagsOff',
	contextFailure,
) {}

/** 409 `execution_context_binding_unavailable`: the bound context failed. */
export class PublishBindingUnavailable extends Schema.TaggedError<PublishBindingUnavailable>()(
	'PublishBindingUnavailable',
	{ ...contextFailure, context: Schema.String },
) {}

/** MCP caller error: the run failed, or ended without sealing, or no repo. */
export class PublishContextBuildFailed extends Schema.TaggedError<PublishContextBuildFailed>()(
	'PublishContextBuildFailed',
	contextFailure,
) {}

/** MCP caller error: `packagePublishBuildCreate` refused to start a build. */
export class PublishBuildCreateRefused extends Schema.TaggedError<PublishBuildCreateRefused>()(
	'PublishBuildCreateRefused',
	{ message: Schema.String },
) {}
