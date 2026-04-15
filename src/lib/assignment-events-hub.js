function writeSseEvent(res, eventName, payload) {
    if (eventName) {
        res.write(`event: ${eventName}\n`);
    }

    if (payload !== undefined) {
        res.write(`data: ${JSON.stringify(payload)}\n`);
    }

    res.write("\n");
}

function createAssignmentEventsHub({ heartbeatMs = 25000 } = {}) {
    const subscribersByUserId = new Map();

    function removeSubscriber(userId, subscriber) {
        const subscribers = subscribersByUserId.get(userId);
        if (!subscribers) {
            return;
        }

        subscribers.delete(subscriber);
        if (subscribers.size === 0) {
            subscribersByUserId.delete(userId);
        }
    }

    function subscribe(userId, res) {
        const subscriber = { res };
        const subscribers = subscribersByUserId.get(userId) || new Set();

        subscribers.add(subscriber);
        subscribersByUserId.set(userId, subscribers);

        res.write("retry: 3000\n\n");
        writeSseEvent(res, "ready", { ok: true });

        const heartbeat = setInterval(() => {
            if (res.writableEnded) {
                clearInterval(heartbeat);
                removeSubscriber(userId, subscriber);
                return;
            }

            res.write(": heartbeat\n\n");
        }, heartbeatMs);

        return () => {
            clearInterval(heartbeat);
            removeSubscriber(userId, subscriber);
        };
    }

    function emitToUsers(userIds, event) {
        const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

        uniqueUserIds.forEach((userId) => {
            const subscribers = subscribersByUserId.get(userId);
            if (!subscribers) {
                return;
            }

            subscribers.forEach((subscriber) => {
                try {
                    if (subscriber.res.writableEnded) {
                        removeSubscriber(userId, subscriber);
                        return;
                    }

                    writeSseEvent(subscriber.res, event.type, event);
                } catch (_error) {
                    removeSubscriber(userId, subscriber);
                }
            });
        });
    }

    return {
        subscribe,
        emitToUsers,
    };
}

module.exports = {
    createAssignmentEventsHub,
};
