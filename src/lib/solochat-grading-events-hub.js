function writeSseEvent(res, eventName, payload) {
    if (eventName) {
        res.write(`event: ${eventName}\n`);
    }

    if (payload !== undefined) {
        res.write(`data: ${JSON.stringify(payload)}\n`);
    }

    res.write("\n");
}

function createSoloChatGradingEventsHub({ heartbeatMs = 25000 } = {}) {
    const subscribersByTaskId = new Map();

    function removeSubscriber(taskId, subscriber) {
        const subscribers = subscribersByTaskId.get(taskId);
        if (!subscribers) {
            return;
        }

        subscribers.delete(subscriber);
        if (subscribers.size === 0) {
            subscribersByTaskId.delete(taskId);
        }
    }

    function subscribe(taskId, userId, res) {
        const subscriber = { res, userId };
        const subscribers = subscribersByTaskId.get(taskId) || new Set();

        subscribers.add(subscriber);
        subscribersByTaskId.set(taskId, subscribers);

        res.write("retry: 3000\n\n");
        writeSseEvent(res, "ready", { ok: true });

        const heartbeat = setInterval(() => {
            if (res.writableEnded) {
                clearInterval(heartbeat);
                removeSubscriber(taskId, subscriber);
                return;
            }

            res.write(": heartbeat\n\n");
        }, heartbeatMs);

        return () => {
            clearInterval(heartbeat);
            removeSubscriber(taskId, subscriber);
        };
    }

    function emitToTask(taskId, event) {
        if (!taskId) {
            return;
        }

        const subscribers = subscribersByTaskId.get(String(taskId));
        if (!subscribers) {
            return;
        }

        subscribers.forEach((subscriber) => {
            try {
                if (subscriber.res.writableEnded) {
                    removeSubscriber(String(taskId), subscriber);
                    return;
                }

                writeSseEvent(subscriber.res, event.type, event);
            } catch (_error) {
                removeSubscriber(String(taskId), subscriber);
            }
        });
    }

    function sendEvent(res, event) {
        writeSseEvent(res, event.type, event);
    }

    return {
        sendEvent,
        subscribe,
        emitToTask,
    };
}

module.exports = {
    createSoloChatGradingEventsHub,
};
