package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/kakuraccho/mite/server/db/generated"
	"github.com/kakuraccho/mite/server/internal/domain"
)

type CompanionStore interface {
	WithinCompanionTransaction(context.Context, func(CompanionTx) error) error
	GetUserPair(context.Context, domain.ID) (domain.UserPair, bool, error)
	GetUser(context.Context, domain.ID) (domain.User, bool, error)
	GetUserPresence(context.Context, domain.ID) (domain.UserPresence, bool, error)
	ListPushSubscriptions(context.Context, domain.ID) ([]domain.PushSubscription, error)
	DeletePushSubscriptionByID(context.Context, domain.ID) error
}

type CompanionTx interface {
	LockUserPresence(context.Context, domain.ID) (domain.UserPresence, bool, error)
	CreateUserPresence(context.Context, domain.ID, time.Time) (domain.UserPresence, error)
	UpdateUserPresence(context.Context, domain.UserPresence) (domain.UserPresence, error)
	GetPendingSupportRequest(context.Context, domain.ID) (domain.SupportRequest, bool, error)
	ReservePresenceNotification(context.Context, domain.ID, int64, time.Time) (bool, error)
	CurrentPresenceEpoch(context.Context, domain.ID) (int64, bool, error)
	UpsertPushSubscription(context.Context, domain.PushSubscription) (domain.PushSubscription, error)
	DeletePushSubscription(context.Context, domain.ID, string) (bool, error)
}

type CompanionRepository struct{ pool *pgxpool.Pool }

func NewCompanionRepository(pool *pgxpool.Pool) *CompanionRepository {
	return &CompanionRepository{pool: pool}
}

func (r *CompanionRepository) WithinCompanionTransaction(ctx context.Context, work func(CompanionTx) error) error {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin companion transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := work(&postgresCompanionTx{queries: dbgen.New(tx)}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit companion transaction: %w", err)
	}
	return nil
}

func (r *CompanionRepository) GetUserPair(ctx context.Context, actorID domain.ID) (domain.UserPair, bool, error) {
	return getUserPair(ctx, dbgen.New(r.pool), actorID)
}

func (r *CompanionRepository) GetUser(ctx context.Context, id domain.ID) (domain.User, bool, error) {
	row, err := dbgen.New(r.pool).GetUserByID(ctx, string(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, false, nil
	}
	if err != nil {
		return domain.User{}, false, fmt.Errorf("get companion user: %w", err)
	}
	return domain.User{ID: domain.ID(row.ID), Role: domain.Role(row.Role), DisplayName: row.DisplayName}, true, nil
}

func (r *CompanionRepository) GetUserPresence(ctx context.Context, userID domain.ID) (domain.UserPresence, bool, error) {
	row, err := dbgen.New(r.pool).CompanionGetUserPresence(ctx, string(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.UserPresence{}, false, nil
	}
	if err != nil {
		return domain.UserPresence{}, false, fmt.Errorf("get user presence: %w", err)
	}
	presence, err := companionPresenceFromDB(row)
	return presence, true, err
}

func (r *CompanionRepository) ListPushSubscriptions(ctx context.Context, familyID domain.ID) ([]domain.PushSubscription, error) {
	rows, err := dbgen.New(r.pool).CompanionListPushSubscriptions(ctx, string(familyID))
	if err != nil {
		return nil, fmt.Errorf("list push subscriptions: %w", err)
	}
	result := make([]domain.PushSubscription, 0, len(rows))
	for _, row := range rows {
		subscription, err := companionPushSubscriptionFromDB(row)
		if err != nil {
			return nil, err
		}
		result = append(result, subscription)
	}
	return result, nil
}

func (r *CompanionRepository) DeletePushSubscriptionByID(ctx context.Context, id domain.ID) error {
	if err := dbgen.New(r.pool).CompanionDeletePushSubscriptionByID(ctx, string(id)); err != nil {
		return fmt.Errorf("delete push subscription by ID: %w", err)
	}
	return nil
}

type postgresCompanionTx struct{ queries *dbgen.Queries }

func (t *postgresCompanionTx) LockUserPresence(ctx context.Context, userID domain.ID) (domain.UserPresence, bool, error) {
	row, err := t.queries.CompanionLockUserPresence(ctx, string(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.UserPresence{}, false, nil
	}
	if err != nil {
		return domain.UserPresence{}, false, fmt.Errorf("lock user presence: %w", err)
	}
	presence, err := companionPresenceFromDB(row)
	return presence, true, err
}

func (t *postgresCompanionTx) CreateUserPresence(ctx context.Context, userID domain.ID, now time.Time) (domain.UserPresence, error) {
	row, err := t.queries.CompanionCreateUserPresence(ctx, dbgen.CompanionCreateUserPresenceParams{UserID: string(userID), ConnectedSince: pgTimestamp(now)})
	if err != nil {
		return domain.UserPresence{}, fmt.Errorf("create user presence: %w", err)
	}
	return companionPresenceFromDB(row)
}

func (t *postgresCompanionTx) UpdateUserPresence(ctx context.Context, presence domain.UserPresence) (domain.UserPresence, error) {
	row, err := t.queries.CompanionUpdateUserPresence(ctx, dbgen.CompanionUpdateUserPresenceParams{
		ConnectedSince: requiredTimestamptz(presence.ConnectedSince), LastSeenAt: requiredTimestamptz(presence.LastSeenAt),
		ConnectionEpoch: presence.ConnectionEpoch, UpdatedAt: requiredTimestamptz(presence.UpdatedAt), UserID: string(presence.UserID),
	})
	if err != nil {
		return domain.UserPresence{}, fmt.Errorf("update user presence: %w", err)
	}
	return companionPresenceFromDB(row)
}

func (t *postgresCompanionTx) GetPendingSupportRequest(ctx context.Context, userID domain.ID) (domain.SupportRequest, bool, error) {
	row, err := t.queries.CompanionGetPendingSupportRequest(ctx, string(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SupportRequest{}, false, nil
	}
	if err != nil {
		return domain.SupportRequest{}, false, fmt.Errorf("get pending support request: %w", err)
	}
	request, err := artifactSupportRequestFromDB(row)
	return request, true, err
}

func (t *postgresCompanionTx) ReservePresenceNotification(ctx context.Context, requestID domain.ID, epoch int64, now time.Time) (bool, error) {
	rows, err := t.queries.CompanionReservePresenceNotification(ctx, dbgen.CompanionReservePresenceNotificationParams{
		SupportRequestID: string(requestID), ConnectionEpoch: epoch, CreatedAt: pgTimestamp(now),
	})
	if err != nil {
		return false, fmt.Errorf("reserve presence notification: %w", err)
	}
	return rows == 1, nil
}

func (t *postgresCompanionTx) CurrentPresenceEpoch(ctx context.Context, userID domain.ID) (int64, bool, error) {
	epoch, err := t.queries.CompanionCurrentPresenceEpoch(ctx, string(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("get current presence epoch: %w", err)
	}
	return epoch, true, nil
}

func (t *postgresCompanionTx) UpsertPushSubscription(ctx context.Context, subscription domain.PushSubscription) (domain.PushSubscription, error) {
	row, err := t.queries.CompanionUpsertPushSubscription(ctx, dbgen.CompanionUpsertPushSubscriptionParams{
		ID: string(subscription.ID), FamilyID: string(subscription.FamilyID), Endpoint: subscription.Endpoint,
		P256dh: subscription.P256DH, Auth: subscription.Auth, CreatedAt: pgTimestamp(subscription.CreatedAt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.PushSubscription{}, domain.NewError(domain.CodeForbidden, "このPush購読を更新する権限がない")
	}
	if err != nil {
		return domain.PushSubscription{}, fmt.Errorf("upsert push subscription: %w", err)
	}
	return companionPushSubscriptionFromDB(row)
}

func (t *postgresCompanionTx) DeletePushSubscription(ctx context.Context, familyID domain.ID, endpoint string) (bool, error) {
	rows, err := t.queries.CompanionDeletePushSubscription(ctx, dbgen.CompanionDeletePushSubscriptionParams{FamilyID: string(familyID), Endpoint: endpoint})
	if err != nil {
		return false, fmt.Errorf("delete push subscription: %w", err)
	}
	return rows > 0, nil
}

func companionPresenceFromDB(row *dbgen.UserPresence) (domain.UserPresence, error) {
	connectedSince := optionalTime(row.ConnectedSince)
	lastSeenAt := optionalTime(row.LastSeenAt)
	updatedAt := optionalTime(row.UpdatedAt)
	presence := domain.UserPresence{UserID: domain.ID(row.UserID), ConnectedSince: connectedSince, LastSeenAt: lastSeenAt, UpdatedAt: updatedAt, ConnectionEpoch: row.ConnectionEpoch, Revision: row.Revision}
	return presence, presence.ValidateStored()
}

func companionPushSubscriptionFromDB(row *dbgen.PushSubscription) (domain.PushSubscription, error) {
	subscription := domain.PushSubscription{ID: domain.ID(row.ID), FamilyID: domain.ID(row.FamilyID), Endpoint: row.Endpoint, P256DH: row.P256dh, Auth: row.Auth, CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}
	return subscription, subscription.Validate()
}
