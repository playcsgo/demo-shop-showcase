package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

func openDB(cfg config) (*sql.DB, error) {
	db, err := sql.Open("mysql", cfg.dbDSN)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(cfg.dbMaxOpen)
	db.SetMaxIdleConns(cfg.dbMaxOpen)
	db.SetConnMaxLifetime(5 * time.Minute)
	return db, nil
}

// 資料庫的「現在」：UTC、到秒（Laravel 寫入的是 'Y-m-d H:i:s'；帶毫秒的話 MySQL 會四捨五入，可能多一秒）
func now() time.Time { return time.Now().UTC().Truncate(time.Second) }

func mysqlCode(err error) uint16 {
	var me *mysql.MySQLError
	if errors.As(err, &me) {
		return me.Number
	}
	return 0
}

func isDuplicate(err error, index string) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1062 && (index == "" || strings.Contains(me.Message, index))
}

// 交易：和 Laravel 的 DB::transaction(attempts: 3) 一樣，死鎖或等鎖逾時就整個重做，最多 3 次
func withTx(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) error {
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		err = runTx(ctx, db, fn)
		if code := mysqlCode(err); code != 1213 && code != 1205 {
			return err
		}
	}
	return err
}

func runTx(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			tx.Rollback()
			panic(p)
		}
		if err != nil {
			tx.Rollback()
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// 可以是 *sql.DB 或 *sql.Tx
type queryer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func execAffected(ctx context.Context, q queryer, query string, args ...any) (int64, error) {
	r, err := q.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

// IN (?, ?, …) 的佔位符
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}
