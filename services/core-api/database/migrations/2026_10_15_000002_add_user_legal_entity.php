<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** operator 管整個法人：範圍＝這個法人底下所有品牌（之後新增的品牌也自動包含，不用逐一指派） */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->foreignId('legal_entity_id')->nullable()->after('email')->constrained();
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropConstrainedForeignId('legal_entity_id');
        });
    }
};
